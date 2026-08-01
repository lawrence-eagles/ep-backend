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
    return res.status(400).json({ error: "Invalid commentId" });
  }

  const { commentId } = parsed.data;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
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
      // 🔥 Get comment + post info
      const result = await tx.execute<{
        comment_id: string;
        post_id: string;
        slug: string;
        category_id: string | null;
      }>(sql`
        SELECT 
          c.id as comment_id,
          c.post_id,
          p.slug,
          p.category_id
        FROM comments c
        INNER JOIN posts p ON c.post_id = p.id
        WHERE c.id = ${commentId}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        throw new Error("Invalid commentId");
      }

      const row = result.rows[0];
      postId = row.post_id;
      slug = row.slug;
      categoryId = row.category_id;

      // 🔥 Insert like WITH post_id (safe + deduplicated)
      const likeResult = await tx.execute(sql`
        INSERT INTO comment_likes (user_id, comment_id, post_id)
        SELECT ${userId}, c.id, c.post_id
        FROM comments c
        WHERE c.id = ${commentId}
        ON CONFLICT (user_id, comment_id) DO NOTHING
        RETURNING 1
      `);

      isNewLike = likeResult.rows.length > 0;

      if (!isNewLike) return;

      // 🔥 Increment comment likes (still needed unless you add INSERT trigger)
      await tx.execute(sql`
        UPDATE comments
        SET likes_count = likes_count + 1
        WHERE id = ${commentId}
      `);

      // 🔥 Boost post score
      await tx.execute(sql`
        UPDATE posts
        SET score = score + 2
        WHERE id = ${postId}
      `);

      // 🔥 User behavior update
      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 2)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET 
            score = user_behavior.score + 2
        `);
      }
    });

    // =========================
    // 3. CACHE (BEST EFFORT)
    // =========================
    if (isNewLike && postId && slug) {
      const redis = await getRedisSafe();

      if (redis) {
        try {
          const ttl = 60 * 60 * 24 * 30;
          const pipeline = redis.multi();

          // 🔥 COMMENTS INVALIDATION (CRITICAL)
          pipeline.incr(`comments:${postId}:version`);
          pipeline.expire(`comments:${postId}:version`, ttl);

          // 🔥 Post cache
          pipeline.incr(`post:${slug}:version`);
          pipeline.expire(`post:${slug}:version`, ttl);

          // 🔥 Feed cache
          pipeline.incr(`feed:${userId}:version`);
          pipeline.expire(`feed:${userId}:version`, ttl);

          // 🔥 Trending
          pipeline.incr(`feed:trending:version`);
          pipeline.expire(`feed:trending:version`, ttl);

          // 🔥 Optional: granular comment cache
          pipeline.del(`comment:${commentId}`);

          if (categoryId) {
            pipeline.incr(`category_feed:${userId}:version`);
            pipeline.expire(`category_feed:${userId}:version`, ttl);

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
  } catch (err) {
    console.error("COMMENT LIKE ERROR:", err);

    if ((err as Error).message === "Invalid commentId") {
      return res.status(400).json({ error: "Invalid commentId" });
    }

    return res.status(500).json({
      error: "Comment like failed",
    });
  }
};
