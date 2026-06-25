import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

// =========================
// 🔥 SAFE REDIS EXECUTOR
// =========================
async function safeCacheInvalidate(
  fn: (redis: Awaited<ReturnType<typeof getRedis>>) => Promise<void>,
) {
  try {
    const redis = await getRedis();
    await fn(redis);
  } catch (err) {
    // 🔥 Never break request because of Redis
    console.error("REDIS ERROR (non-blocking):", err);
  }
}

// =========================
// 🔥 FOLLOW CATEGORY
// =========================
export const followVersionOne = async (req: Request, res: Response) => {
  // =========================
  // 1. VALIDATION FIRST (NO REDIS)
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  const { categoryId } = req.body;

  if (!categoryId) {
    return res.status(400).json({
      error: "Missing categoryId",
    });
  }

  const userId = req.user.id;

  let isNewFollow = false;

  try {
    // =========================
    // 2. TRANSACTION (SOURCE OF TRUTH)
    // =========================
    await db.transaction(async (tx) => {
      // ✅ Validate category exists
      const categoryResult = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM categories
        WHERE id = ${categoryId}
        LIMIT 1
      `);

      if (categoryResult.rows.length === 0) {
        throw new Error("Invalid categoryId");
      }

      const validCategoryId = categoryResult.rows[0].id;

      // ✅ Insert follow (idempotent)
      const result = await tx.execute(sql`
        INSERT INTO follows (user_id, category_id)
        VALUES (${userId}, ${validCategoryId})
        ON CONFLICT (user_id, category_id) DO NOTHING
        RETURNING 1
      `);

      isNewFollow = result.rows.length > 0;

      if (!isNewFollow) return;

      // ✅ Update user behavior
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${validCategoryId}, 10)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 10
      `);
    });

    // =========================
    // 3. RESPONSE FIRST
    // =========================
    res.status(200).json({
      success: true,
      isNewFollow,
    });

    // =========================
    // 4. CACHE INVALIDATION (NON-BLOCKING)
    // =========================
    if (isNewFollow) {
      void safeCacheInvalidate(async (redis) => {
        const pipeline = redis.multi();

        pipeline.incr(`following:${userId}:version`);
        pipeline.incr(`feed:${userId}:version`);

        await pipeline.exec();
      });
    }
  } catch (err) {
    console.error("FOLLOW CATEGORY ERROR:", err);

    if ((err as Error).message === "Invalid categoryId") {
      return res.status(400).json({ error: "Invalid categoryId" });
    }

    return res.status(500).json({
      error: "Follow category failed",
    });
  }
};

// =========================
// 🔥 UNFOLLOW CATEGORY
// =========================
export const unfollowVersionOne = async (req: Request, res: Response) => {
  // =========================
  // 1. VALIDATION FIRST
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  const { categoryId } = req.params;

  if (!categoryId) {
    return res.status(400).json({
      error: "Missing categoryId",
    });
  }

  const userId = req.user.id;

  let wasUnfollowed = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      const categoryResult = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM categories
        WHERE id = ${categoryId}
        LIMIT 1
      `);

      if (categoryResult.rows.length === 0) {
        throw new Error("Invalid categoryId");
      }

      const validCategoryId = categoryResult.rows[0].id;

      // ✅ Delete follow (idempotent)
      const deleteResult = await tx.execute(sql`
        DELETE FROM follows
        WHERE user_id = ${userId}
          AND category_id = ${validCategoryId}
        RETURNING 1
      `);

      wasUnfollowed = deleteResult.rows.length > 0;

      if (!wasUnfollowed) return;

      // ✅ Update user behavior
      await tx.execute(sql`
        UPDATE user_behavior
        SET score = GREATEST(score - 10, 0)
        WHERE user_id = ${userId}
          AND category_id = ${validCategoryId}
      `);
    });

    // =========================
    // 3. RESPONSE FIRST
    // =========================
    res.status(200).json({
      success: true,
      wasUnfollowed,
    });

    // =========================
    // 4. CACHE INVALIDATION (NON-BLOCKING)
    // =========================
    if (wasUnfollowed) {
      void safeCacheInvalidate(async (redis) => {
        const pipeline = redis.multi();

        pipeline.incr(`following:${userId}:version`);
        pipeline.incr(`feed:${userId}:version`);

        await pipeline.exec();
      });
    }
  } catch (err) {
    console.error("UNFOLLOW CATEGORY ERROR:", err);

    if ((err as Error).message === "Invalid categoryId") {
      return res.status(400).json({ error: "Invalid categoryId" });
    }

    return res.status(500).json({
      error: "Unfollow category failed",
    });
  }
};
