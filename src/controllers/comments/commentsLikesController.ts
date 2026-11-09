import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db";
import { getRedis } from "../../lib/redis";
import { z } from "zod";

// =========================
// 🔥 SAFE REDIS HELPER
// =========================
async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

// =========================
// 👍 LIKE COMMENT / REPLY
// =========================
export const likeCommentVersionOne = async (req: Request, res: Response) => {
  const LikeCommentSchema = z.object({
    commentId: z.uuid(),
  });

  const parsed = LikeCommentSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid commentId",
    });
  }

  const { commentId } = parsed.data;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({
      error: "Unauthorized user",
    });
  }

  if (!commentId) {
    return res.status(400).json({
      error: "Missing commentId",
    });
  }

  const userId = req.user.id;

  let isNewLike = false;
  let postId: string | null = null;
  let slug: string | null = null;
  let categoryId: string | null = null;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // =========================
      // 2A. GET INITIAL POST ID
      // =========================
      // We need the post ID before acquiring the advisory lock.
      // The initial lookup is only used to determine the lock key.
      const initialResult = await tx.execute<{
        post_id: string;
      }>(sql`
        SELECT post_id
        FROM comments
        WHERE id = ${commentId}
        LIMIT 1
      `);

      if (initialResult.rows.length === 0) {
        throw new Error("Invalid commentId");
      }

      const initialPostId = initialResult.rows[0].post_id;

      // =========================
      // 2B. ACQUIRE POST-LEVEL ADVISORY LOCK
      // =========================
      // Serialize this like operation with comment creation
      // and moderation deletion for the same post.
      //
      // PostgreSQL automatically releases this transaction-level
      // lock when the transaction commits or rolls back.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${initialPostId}, 0)
        )
      `);

      // =========================
      // 2C. RECHECK COMMENT AVAILABILITY
      // =========================
      // Re-fetch the comment after acquiring the lock.
      // A soft-deleted comment must never receive a new like.
      const result = await tx.execute<{
        comment_id: string;
        post_id: string;
        slug: string;
        category_id: string | null;
      }>(sql`
        SELECT
          c.id AS comment_id,
          c.post_id,
          p.slug,
          p.category_id
        FROM comments c
        INNER JOIN posts p ON c.post_id = p.id
        WHERE c.id = ${commentId}
          AND c.is_deleted = FALSE
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        throw new Error("COMMENT_NOT_AVAILABLE");
      }

      const row = result.rows[0];

      postId = row.post_id;
      slug = row.slug;
      categoryId = row.category_id;

      // =========================
      // 2D. INSERT LIKE
      // =========================
      // Include the soft-delete condition again in the INSERT.
      // The unique constraint prevents duplicate likes.
      const likeResult = await tx.execute(sql`
        INSERT INTO comment_likes (
          user_id,
          comment_id,
          post_id
        )
        SELECT
          ${userId},
          c.id,
          c.post_id
        FROM comments c
        WHERE c.id = ${commentId}
          AND c.is_deleted = FALSE
        ON CONFLICT (user_id, comment_id) DO NOTHING
        RETURNING 1
      `);

      isNewLike = likeResult.rows.length > 0;

      // If the user already liked this comment, do not update
      // any counters or user behavior scores.
      if (!isNewLike) return;

      // =========================
      // 2E. INCREMENT COMMENT LIKES
      // =========================
      await tx.execute(sql`
        UPDATE comments
        SET likes_count = likes_count + 1
        WHERE id = ${commentId}
          AND is_deleted = FALSE
      `);

      // =========================
      // 2F. BOOST POST SCORE
      // =========================
      await tx.execute(sql`
        UPDATE posts
        SET score = score + 2
        WHERE id = ${postId}
      `);

      // =========================
      // 2G. UPDATE USER BEHAVIOR
      // =========================
      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (
            user_id,
            category_id,
            score
          )
          VALUES (
            ${userId},
            ${categoryId},
            2
          )
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET
            score = user_behavior.score + 2
        `);
      }
    });

    // =========================
    // 3. CACHE INVALIDATION
    // =========================
    // Cache invalidation is best effort and happens only
    // when a new like was successfully created.
    if (isNewLike && postId && slug) {
      const redis = await getRedisSafe();

      if (redis) {
        try {
          const ttl = 60 * 60 * 24 * 30;
          const pipeline = redis.multi();

          // Comments cache.
          pipeline.incr(`comments:${postId}:version`);
          pipeline.expire(`comments:${postId}:version`, ttl);

          // Individual post cache.
          pipeline.incr(`post:${slug}:version`);
          pipeline.expire(`post:${slug}:version`, ttl);

          // User feed cache.
          pipeline.incr(`feed:${userId}:version`);
          pipeline.expire(`feed:${userId}:version`, ttl);

          // Trending feed cache.
          pipeline.incr("feed:trending:version");
          pipeline.expire("feed:trending:version", ttl);

          // Individual comment cache.
          pipeline.del(`comment:${commentId}`);

          if (categoryId) {
            // User category feed cache.
            pipeline.incr(`category_feed:${userId}:version`);
            pipeline.expire(`category_feed:${userId}:version`, ttl);

            // Global category cache.
            pipeline.incr(`category:${categoryId}:version`);
            pipeline.expire(`category:${categoryId}:version`, ttl);
          }

          await pipeline.exec();
        } catch (err) {
          console.error("REDIS COMMENT LIKE ERROR:", err);
        }
      }
    }

    // =========================
    // 4. RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      isNewLike,
    });
  } catch (err: unknown) {
    console.error("COMMENT LIKE ERROR:", err);

    const message = err instanceof Error ? err.message : "";

    if (message === "Invalid commentId") {
      return res.status(400).json({
        error: "Invalid commentId",
      });
    }

    if (message === "COMMENT_NOT_AVAILABLE") {
      return res.status(404).json({
        error: "Comment not found or is no longer available",
      });
    }

    return res.status(500).json({
      error: "Comment like failed",
    });
  }
};
