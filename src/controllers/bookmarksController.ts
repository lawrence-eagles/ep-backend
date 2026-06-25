import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

// =========================
// 🔥 SAFE REDIS HELPER
// =========================
async function safeCacheInvalidate(
  fn: (redis: Awaited<ReturnType<typeof getRedis>>) => Promise<void>,
) {
  try {
    const redis = await getRedis();
    await fn(redis);
  } catch (err) {
    // 🔥 NEVER crash request because of cache
    console.error("REDIS ERROR (non-blocking):", err);
  }
}

// =========================
// 🔥 BOOKMARK
// =========================
export const bookmarkVersionOne = async (req: Request, res: Response) => {
  // =========================
  // 1. AUTH VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  const userId = req.user.id;
  const { postId } = req.body;

  if (!postId) {
    return res.status(400).json({
      error: "Missing postId",
    });
  }

  let isNewBookmark = false;
  let slug: string | null = null;

  try {
    // =========================
    // 2. TRANSACTION (SOURCE OF TRUTH)
    // =========================
    await db.transaction(async (tx) => {
      const postResult = await tx.execute<{
        id: string;
        slug: string;
        category_id: string | null;
      }>(sql`
        SELECT id, slug, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length === 0) {
        throw new Error("Invalid postId");
      }

      const post = postResult.rows[0];
      slug = post.slug;
      const categoryId = post.category_id;

      const insertResult = await tx.execute(sql`
        INSERT INTO bookmarks (user_id, post_id)
        VALUES (${userId}, ${postId})
        ON CONFLICT (user_id, post_id) DO NOTHING
        RETURNING 1
      `);

      isNewBookmark = insertResult.rows.length > 0;

      if (!isNewBookmark) return;

      await tx.execute(sql`
        UPDATE posts
        SET score = score + 8
        WHERE id = ${postId}
      `);

      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 8)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET 
            score = user_behavior.score + 8
        `);
      }
    });

    // =========================
    // 3. RESPONSE FIRST (🔥 IMPORTANT)
    // =========================
    res.status(200).json({
      success: true,
      isNewBookmark,
    });

    // =========================
    // 4. CACHE INVALIDATION (NON-BLOCKING)
    // =========================
    if (isNewBookmark && slug) {
      void safeCacheInvalidate(async (redis) => {
        const pipeline = redis.multi();

        pipeline.incr(`bookmarks:${userId}:version`);
        pipeline.incr(`post:${slug}:version`);
        pipeline.incr(`feed:${userId}:version`);

        await pipeline.exec();
      });
    }
  } catch (err) {
    console.error("BOOKMARK ERROR:", err);

    if ((err as Error).message === "Invalid postId") {
      return res.status(400).json({ error: "Invalid postId" });
    }

    return res.status(500).json({
      error: "Bookmark failed",
    });
  }
};

// =========================
// 🔥 UNBOOKMARK
// =========================
export const unbookmarkVersionOne = async (req: Request, res: Response) => {
  const { postId } = req.params;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  if (!postId) {
    return res.status(400).json({
      error: "Missing postId",
    });
  }

  const userId = req.user.id;

  let wasDeleted = false;
  let slug: string | null = null;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      const postResult = await tx.execute<{
        id: string;
        slug: string;
        category_id: string | null;
      }>(sql`
        SELECT id, slug, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length === 0) {
        throw new Error("Invalid postId");
      }

      const post = postResult.rows[0];
      slug = post.slug;
      const categoryId = post.category_id;

      const deleteResult = await tx.execute(sql`
        DELETE FROM bookmarks
        WHERE user_id = ${userId}
          AND post_id = ${postId}
        RETURNING 1
      `);

      wasDeleted = deleteResult.rows.length > 0;

      if (!wasDeleted) return;

      await tx.execute(sql`
        UPDATE posts
        SET score = GREATEST(score - 8, 0)
        WHERE id = ${postId}
      `);

      if (categoryId) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - 8, 0)
          WHERE user_id = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // =========================
    // 3. RESPONSE FIRST
    // =========================
    res.status(200).json({
      success: true,
      wasDeleted,
    });

    // =========================
    // 4. CACHE INVALIDATION (NON-BLOCKING)
    // =========================
    if (wasDeleted && slug) {
      void safeCacheInvalidate(async (redis) => {
        const pipeline = redis.multi();

        pipeline.incr(`bookmarks:${userId}:version`);
        pipeline.incr(`post:${slug}:version`);
        pipeline.incr(`feed:${userId}:version`);

        await pipeline.exec();
      });
    }
  } catch (err) {
    console.error("UNBOOKMARK ERROR:", err);

    if ((err as Error).message === "Invalid postId") {
      return res.status(400).json({ error: "Invalid postId" });
    }

    return res.status(500).json({
      error: "Unbookmark failed",
    });
  }
};
