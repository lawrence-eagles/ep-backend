import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

export const followVersionOne = async (req: Request, res: Response) => {
  // INITIALIZE REDIS
  const redis = await getRedis();

  const { categoryId } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  if (!categoryId) {
    return res.status(400).json({
      error: "Missing categoryId",
    });
  }

  // GET USER ID FROM req.user COMING FROM MIDDLEWARE
  const userId = req.user.id;

  let isNewFollow = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // ✅ 1. Ensure category EXISTS (DO NOT trust client blindly)
      const categoryResult = await tx.execute(sql`
        SELECT id FROM categories
        WHERE id = ${categoryId}
        LIMIT 1
      `);

      if (categoryResult.rows.length === 0) {
        throw new Error("Invalid category");
      }

      const validCategoryId = categoryResult.rows[0].id;

      // ✅ 2. Insert follow safely
      const result = await tx.execute(sql`
        INSERT INTO follows (user_id, category_id)
        VALUES (${userId}, ${validCategoryId})
        ON CONFLICT (user_id, category_id) DO NOTHING
        RETURNING 1
      `);

      isNewFollow = result.rows.length > 0;

      if (!isNewFollow) return;

      // ✅ 3. Update user behavior (SAFE increment, no overwrite bug)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${validCategoryId}, 10)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 10
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (isNewFollow) {
      const pipeline = redis.multi();

      // Invalidate following feed
      pipeline.incr(`following:${userId}:version`);

      // Invalidate personalized feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      isNewFollow,
    });
  } catch (err) {
    console.error("FOLLOW CATEGORY ERROR:", err);

    // ✅ Better error handling
    if (err instanceof Error && err.message === "Invalid category") {
      return res.status(400).json({ error: "Invalid categoryId" });
    }

    return res.status(500).json({ error: "Follow category failed" });
  }
};

export const unfollowVersionOne = async (req: Request, res: Response) => {
  // INITIALIZE REDIS
  const redis = await getRedis();

  const { categoryId } = req.params;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  if (!categoryId) {
    return res.status(400).json({
      error: "Missing categoryId",
    });
  }

  // GET USER ID FROM req.user COMING FROM MIDDLEWARE
  const userId = req.user.id;

  let wasUnfollowed = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // ✅ 1. VERIFY CATEGORY EXISTS
      const categoryResult = await tx.execute(sql`
        SELECT id 
        FROM categories 
        WHERE id = ${categoryId}
        LIMIT 1
      `);

      if (categoryResult.rows.length === 0) {
        throw new Error("Invalid categoryId");
      }

      // ✅ SAFE SOURCE OF TRUTH
      const validCategoryId = categoryResult.rows[0].id;

      // ✅ 2. DELETE FOLLOW (USE VALID ID)
      const deleteResult = await tx.execute(sql`
        DELETE FROM follows
        WHERE user_id = ${userId}
          AND category_id = ${validCategoryId}
        RETURNING 1
      `);

      wasUnfollowed = deleteResult.rows.length > 0;

      if (!wasUnfollowed) return;

      // ✅ 3. UPDATE USER BEHAVIOR (USE VALID ID)
      await tx.execute(sql`
        UPDATE user_behavior
        SET score = GREATEST(score - 10, 1)
        WHERE user_id = ${userId}
          AND category_id = ${validCategoryId}
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION
    // =========================
    if (wasUnfollowed) {
      const pipeline = redis.multi();

      pipeline.incr(`following:${userId}:version`);
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      wasUnfollowed,
    });
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
