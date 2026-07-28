import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db";
import { getRedis } from "../../lib/redis";

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
// 👎 UNLIKE COMMENT / REPLY
// =========================
export const unlikeCommentVersionOne = async (req: Request, res: Response) => {
  const { commentId } = req.params;

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

  let isRemoved = false;
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

      // 🔥 Delete like
      const deleteResult = await tx.execute(sql`
        DELETE FROM comment_likes
        WHERE user_id = ${userId}
          AND comment_id = ${commentId}
        RETURNING 1
      `);

      isRemoved = deleteResult.rows.length > 0;

      if (!isRemoved) return;

      // 🔥 Decrement comment likes safely
      await tx.execute(sql`
        UPDATE comments
        SET likes_count = GREATEST(likes_count - 1, 0)
        WHERE id = ${commentId}
      `);

      // 🔥 Adjust post score (mirror like logic)
      await tx.execute(sql`
        UPDATE posts
        SET score = GREATEST(score - 2, 0)
        WHERE id = ${postId}
      `);

      // 🔥 Adjust user behavior
      if (categoryId) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - 2, 0)
          WHERE user_id = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // =========================
    // 3. CACHE (BEST EFFORT)
    // =========================
    if (isRemoved && postId && slug) {
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

          // 🔥 Trending cache
          pipeline.incr(`feed:trending:version`);
          pipeline.expire(`feed:trending:version`, ttl);

          // 🔥 Optional granular cache
          pipeline.del(`comment:${commentId}`);

          if (categoryId) {
            pipeline.incr(`category_feed:${userId}:version`);
            pipeline.expire(`category_feed:${userId}:version`, ttl);

            pipeline.incr(`category:${categoryId}:version`);
            pipeline.expire(`category:${categoryId}:version`, ttl);
          }

          await pipeline.exec();
        } catch (err) {
          console.error("REDIS COMMENT UNLIKE ERROR:", err);
        }
      }
    }

    // =========================
    // 4. RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      isRemoved,
    });
  } catch (err) {
    console.error("COMMENT UNLIKE ERROR:", err);

    if ((err as Error).message === "Invalid commentId") {
      return res.status(400).json({ error: "Invalid commentId" });
    }

    return res.status(500).json({
      error: "Comment unlike failed",
    });
  }
};
