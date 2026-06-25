import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

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
// 👍 LIKE
// =========================
export const likeVersionOne = async (req: Request, res: Response) => {
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

  let isNewLike = false;
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

      const likeResult = await tx.execute(sql`
        INSERT INTO likes (user_id, post_id)
        VALUES (${userId}, ${postId})
        ON CONFLICT (user_id, post_id) DO NOTHING
        RETURNING 1
      `);

      isNewLike = likeResult.rows.length > 0;

      if (!isNewLike) return;

      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = likes_count + 1,
          score = score + 5
        WHERE id = ${postId}
      `);

      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 5)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET 
            score = user_behavior.score + 5
        `);
      }
    });

    // =========================
    // 3. CACHE (BEST EFFORT)
    // =========================
    if (isNewLike && slug) {
      const redis = await getRedisSafe();

      if (redis) {
        try {
          const pipeline = redis.multi();

          pipeline.incr(`post:${slug}:version`);
          pipeline.incr(`feed:${userId}:version`);
          pipeline.incr(`feed:trending:version`);
          pipeline.incr(`post:${postId}:likes`);

          await pipeline.exec();
        } catch (err) {
          console.error("REDIS LIKE ERROR:", err);
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
    console.error("LIKE ERROR:", err);

    if ((err as Error).message === "Invalid postId") {
      return res.status(400).json({ error: "Invalid postId" });
    }

    return res.status(500).json({
      error: "Like failed",
    });
  }
};

// =========================
// 👎 UNLIKE
// =========================
export const unlikeVersionOne = async (req: Request, res: Response) => {
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

  let isRemoved = false;
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
        DELETE FROM likes
        WHERE user_id = ${userId}
          AND post_id = ${postId}
        RETURNING 1
      `);

      isRemoved = deleteResult.rows.length > 0;

      if (!isRemoved) return;

      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = GREATEST(likes_count - 1, 0),
          score = GREATEST(score - 5, 0)
        WHERE id = ${postId}
      `);

      if (categoryId) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - 5, 0)
          WHERE user_id = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // =========================
    // 3. CACHE (BEST EFFORT)
    // =========================
    if (isRemoved && slug) {
      const redis = await getRedisSafe();

      if (redis) {
        try {
          const pipeline = redis.multi();

          pipeline.incr(`post:${slug}:version`);
          pipeline.incr(`feed:${userId}:version`);
          pipeline.incr(`feed:trending:version`);
          pipeline.decr(`post:${postId}:likes`);

          await pipeline.exec();

          // 🔥 Safety clamp (non-critical)
          const likes = await redis.get(`post:${postId}:likes`);
          if (likes && parseInt(likes, 10) < 0) {
            await redis.set(`post:${postId}:likes`, 0);
          }
        } catch (err) {
          console.error("REDIS UNLIKE ERROR:", err);
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
    console.error("UNLIKE ERROR:", err);

    if ((err as Error).message === "Invalid postId") {
      return res.status(400).json({ error: "Invalid postId" });
    }

    return res.status(500).json({
      error: "Unlike failed",
    });
  }
};
