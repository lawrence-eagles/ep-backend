import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

export const shareVersionOne = async (req: Request, res: Response) => {
  // INITIALIZE REDIS
  const redis = await getRedis();

  const { postId } = req.body;

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

  // GET USER ID FROM req.user COMING FROM MIDDLEWARE
  const userId = req.user.id;

  let didShare = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // ✅ 1. GET POST + CATEGORY (DO NOT TRUST CLIENT)
      const postResult = await tx.execute(sql`
        SELECT id, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length === 0) {
        throw new Error("Invalid postId");
      }

      const validPostId = postResult.rows[0].id;
      const categoryId = postResult.rows[0].category_id;

      // If post has no category → skip behavior update
      // (safe guard for nullable categoryId)
      if (!categoryId) {
        didShare = true;
        return;
      }

      // ✅ 2. UPDATE USER BEHAVIOR (+5)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, 5)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 5
      `);

      // ✅ 3. OPTIONAL: BOOST POST SCORE (recommended for ranking)
      await tx.execute(sql`
        UPDATE posts
        SET score = score + 5
        WHERE id = ${validPostId}
      `);

      didShare = true;
    });

    // =========================
    // 3. REDIS INVALIDATION
    // =========================
    if (didShare) {
      const pipeline = redis.multi();

      // ✅ Only invalidate personalized feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      didShare,
    });
  } catch (err) {
    console.error("SHARE POST ERROR:", err);

    if ((err as Error).message === "Invalid postId") {
      return res.status(400).json({ error: "Invalid postId" });
    }

    return res.status(500).json({
      error: "Share post failed",
    });
  }
};
