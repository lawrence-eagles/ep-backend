import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

// =========================
// 🔥 SAFE REDIS (BEST-EFFORT)
// =========================
async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

export const shareVersionOne = async (req: Request, res: Response) => {
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

  const userId = req.user.id;

  let didShare = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // ✅ 1. Get post (no client trust)
      const postResult = await tx.execute<{
        id: string;
        category_id: string | null;
      }>(sql`
        SELECT id, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length === 0) {
        throw new Error("Invalid postId");
      }

      const post = postResult.rows[0];
      const categoryId = post.category_id;

      // =========================
      // 🔥 OPTIONAL BUT CRITICAL: DEDUPE SHARES
      // Prevent score inflation from retries/spam
      // =========================
      const shareResult = await tx.execute(sql`
        INSERT INTO shares (user_id, post_id)
        VALUES (${userId}, ${postId})
        ON CONFLICT (user_id, post_id) DO NOTHING
        RETURNING 1
      `);

      didShare = shareResult.rows.length > 0;

      // If already shared → EXIT (idempotent behavior)
      if (!didShare) return;

      // =========================
      // 2. Update user behavior
      // =========================
      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 15)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET 
            score = user_behavior.score + 15
        `);
      }

      // =========================
      // 3. Boost post score
      // =========================
      await tx.execute(sql`
        UPDATE posts
        SET score = score + 15
        WHERE id = ${postId}
      `);
    });

    // =========================
    // 3. CACHE (BEST-EFFORT)
    // =========================
    if (didShare) {
      const redis = await getRedisSafe();

      if (redis) {
        try {
          const pipeline = redis.multi();

          // Only invalidate personalized feed
          pipeline.incr(`feed:${userId}:version`);

          await pipeline.exec();
        } catch (err) {
          console.error("REDIS SHARE ERROR:", err);
        }
      }
    }

    // =========================
    // 4. RESPONSE (DB = source of truth)
    // =========================
    return res.status(200).json({
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
