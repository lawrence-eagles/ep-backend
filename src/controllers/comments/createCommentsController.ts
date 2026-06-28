import type { Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";

// ── Config ─────────────────────────────────────────────
const MAX_COMMENT_LENGTH = 2000;
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 15;

// ── Regex ──────────────────────────────────────────────
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
// 🚦 RATE LIMIT (NODE-REDIS SAFE)
// =========================
async function rateLimit(userId: string, action: string): Promise<void> {
  const redis = await getRedisSafe();
  if (!redis) return; // fail open

  const key = `rate:${action}:${userId}`;

  try {
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }

    if (count > RATE_LIMIT_MAX) {
      throw new Error("Too many requests");
    }
  } catch (err) {
    console.error("RATE LIMIT ERROR:", err);
    // fail open
  }
}

// =========================
// 🚀 CONTROLLER
// =========================
export const createCommentVersionOne = async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. AUTH
    // =========================
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;

    // =========================
    // 2. PARAM NORMALIZATION (FIXED BUG)
    // =========================
    let { postId } = req.params;

    if (Array.isArray(postId)) {
      postId = postId[0];
    }

    if (!postId || !UUID_RE.test(postId)) {
      return res.status(400).json({ error: "Invalid postId" });
    }

    const { content, parentId } = req.body;

    // =========================
    // 3. VALIDATION
    // =========================
    if (typeof content !== "string") {
      return res.status(400).json({ error: "Missing content" });
    }

    const trimmedContent = content.trim();

    if (!trimmedContent) {
      return res.status(400).json({ error: "Empty comment" });
    }

    if (trimmedContent.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: "Comment too long" });
    }

    if (parentId && (!UUID_RE.test(parentId) || typeof parentId !== "string")) {
      return res.status(400).json({ error: "Invalid parentId" });
    }

    // =========================
    // 4. RATE LIMIT
    // =========================
    await rateLimit(userId, "create_comment");

    let createdComment: Record<string, unknown> | null = null;
    let slug: string = "";
    let categoryId: string | null = null;

    // =========================
    // 5. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // 🔍 Get post
      const postResult = await tx.execute(sql`
        SELECT slug, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length === 0) {
        throw new Error("POST_NOT_FOUND");
      }

      const row = postResult.rows[0] as {
        slug: unknown;
        category_id: unknown;
      };

      if (typeof row.slug !== "string") {
        throw new Error("INVALID_SLUG");
      }

      slug = row.slug;
      categoryId = typeof row.category_id === "string" ? row.category_id : null;

      // 🔍 Validate parent comment
      if (parentId) {
        const parent = await tx.execute(sql`
          SELECT id FROM comments
          WHERE id = ${parentId}
            AND post_id = ${postId}
          LIMIT 1
        `);

        if (parent.rows.length === 0) {
          throw new Error("INVALID_PARENT");
        }
      }

      // ➕ Insert comment
      const insert = await tx.execute(sql`
        INSERT INTO comments (content, user_id, post_id, parent_id)
        VALUES (${trimmedContent}, ${userId}, ${postId}, ${parentId ?? null})
        RETURNING *
      `);

      if (!insert.rows[0]) {
        throw new Error("INSERT_FAILED");
      }

      createdComment = insert.rows[0] as Record<string, unknown>;

      // 🔥 Update post stats
      await tx.execute(sql`
        UPDATE posts
        SET score = score + 7,
            comments_count = comments_count + 1
        WHERE id = ${postId}
      `);

      // 🔥 Update user behavior
      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 7)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET score = user_behavior.score + 7
        `);
      }
    });

    // =========================
    // 6. CACHE INVALIDATION (NODE-REDIS SAFE)
    // =========================
    const redis = await getRedisSafe();

    if (redis && slug) {
      try {
        const multi = redis.multi();

        multi.incr(`comments:${postId}:version`);
        multi.incr(`post:${slug}:version`);
        multi.incr(`feed:${userId}:version`);
        multi.incr(`feed:trending:version`);

        await multi.exec();
      } catch (err) {
        console.error("REDIS INVALIDATION ERROR:", err);
      }
    }

    // =========================
    // 7. RESPONSE
    // =========================
    return res.json({
      success: true,
      comment: createdComment,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message === "Too many requests") {
      return res.status(429).json({ error: message });
    }

    if (message === "POST_NOT_FOUND") {
      return res.status(404).json({ error: "Post not found" });
    }

    if (message === "INVALID_PARENT") {
      return res.status(400).json({ error: "Invalid parent comment" });
    }

    console.error("[comments] CREATE error:", err);

    return res.status(500).json({
      error: "Create failed",
    });
  }
};
