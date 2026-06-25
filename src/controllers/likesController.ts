import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";
import { getRedis } from "../lib/redis";

export const likeVersionOne = async (req: Request, res: Response) => {
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

  const userId = req.user.id;

  let isNewLike = false;
  let slug: string | null = null;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // ✅ 1. Get post (slug + category in ONE query)
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

      // ✅ 2. Insert like (idempotent)
      const likeResult = await tx.execute(sql`
        INSERT INTO likes (user_id, post_id)
        VALUES (${userId}, ${postId})
        ON CONFLICT (user_id, post_id) DO NOTHING
        RETURNING 1
      `);

      isNewLike = likeResult.rows.length > 0;

      if (!isNewLike) return;

      // ✅ 3. Update post counters (single query)
      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = likes_count + 1,
          score = score + 5
        WHERE id = ${postId}
      `);

      // ✅ 4. Update user behavior (only if category exists)
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
    // 3. REDIS INVALIDATION
    // =========================
    if (isNewLike && slug) {
      const pipeline = redis.multi();

      // 🔥 Version invalidation (O(1))
      pipeline.incr(`post:${slug}:version`);
      pipeline.incr(`feed:${userId}:version`);
      pipeline.incr(`feed:trending:version`);

      // 🔥 Real-time counter
      pipeline.incr(`post:${postId}:likes`);

      await pipeline.exec();
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

export const unlikeVersionOne = async (req: Request, res: Response) => {
  const redis = await getRedis();

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
      // ✅ 1. Fetch post (slug + category in ONE query)
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

      // ✅ 2. Delete like (idempotent)
      const deleteResult = await tx.execute(sql`
        DELETE FROM likes
        WHERE user_id = ${userId}
          AND post_id = ${postId}
        RETURNING 1
      `);

      isRemoved = deleteResult.rows.length > 0;

      if (!isRemoved) return;

      // ✅ 3. Update post counters (clamped)
      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = GREATEST(likes_count - 1, 0),
          score = GREATEST(score - 5, 0)
        WHERE id = ${postId}
      `);

      // ✅ 4. Update user behavior (only if category exists)
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
    // 3. REDIS INVALIDATION
    // =========================
    if (isRemoved && slug) {
      const pipeline = redis.multi();

      // 🔥 Version invalidation (O(1))
      pipeline.incr(`post:${slug}:version`);
      pipeline.incr(`feed:${userId}:version`);
      pipeline.incr(`feed:trending:version`);

      // 🔥 Real-time counter decrement
      pipeline.decr(`post:${postId}:likes`);

      await pipeline.exec();

      // 🔥 Safety guard (rare but correct)
      const likes = await redis.get(`post:${postId}:likes`);
      if (likes && parseInt(likes, 10) < 0) {
        await redis.set(`post:${postId}:likes`, 0);
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
