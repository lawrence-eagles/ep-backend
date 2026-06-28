import type { Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";

// ── Config ─────────────────────────────────────────────
const RATE_LIMIT_WINDOW = 60;
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
// 🚦 RATE LIMIT
// =========================
async function rateLimit(userId: string, action: string): Promise<void> {
  const redis = await getRedisSafe();
  if (!redis) return;

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
export const deleteCommentVersionOne = async (req: Request, res: Response) => {
  let postId: string | null = null;
  let slug: string | null = null;
  let categoryId: string | null = null;

  try {
    // =========================
    // 1. AUTH
    // =========================
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;

    // =========================
    // 2. PARAM NORMALIZATION
    // =========================
    let { id } = req.params;

    if (Array.isArray(id)) {
      id = id[0];
    }

    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid comment id" });
    }

    // =========================
    // 3. RATE LIMIT
    // =========================
    await rateLimit(userId, "delete_comment");

    // =========================
    // 4. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // 🔍 Get comment + ownership
      const commentResult = await tx.execute(sql`
        SELECT post_id
        FROM comments
        WHERE id = ${id}
          AND user_id = ${userId}
        LIMIT 1
      `);

      if (commentResult.rows.length === 0) {
        return;
      }

      const row = commentResult.rows[0] as { post_id: unknown };

      if (typeof row.post_id !== "string") {
        throw new Error("INVALID_POST_ID");
      }

      postId = row.post_id;

      // 🔍 Get post
      const postResult = await tx.execute(sql`
        SELECT slug, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length > 0) {
        const postRow = postResult.rows[0] as {
          slug: unknown;
          category_id: unknown;
        };

        if (typeof postRow.slug === "string") {
          slug = postRow.slug;
        }

        if (typeof postRow.category_id === "string") {
          categoryId = postRow.category_id;
        }
      }

      // 🗑 Delete comment (cascade handles children)
      await tx.execute(sql`
        DELETE FROM comments WHERE id = ${id}
      `);

      // 🔥 Update post counters if post exists
      if (postId) {
        await tx.execute(sql`
          UPDATE posts
          SET score = GREATEST(score - 7, 0),
              comments_count = GREATEST(comments_count - 1, 0)
          WHERE id = ${postId}
        `);
      }

      // 🔥 Update user behavior
      if (categoryId) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - 7, 0)
          WHERE user_id = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // =========================
    // 5. NOT FOUND CASE
    // =========================
    if (!postId) {
      return res.json({ success: true, deleted: false });
    }

    // =========================
    // 6. CACHE INVALIDATION
    // =========================
    const redis = await getRedisSafe();

    if (redis) {
      try {
        const multi = redis.multi();

        multi.incr(`comments:${postId}:version`);
        multi.incr(`feed:${userId}:version`);
        multi.incr(`feed:trending:version`);

        if (slug) {
          multi.incr(`post:${slug}:version`);
        }

        await multi.exec();
      } catch (err) {
        console.error("REDIS INVALIDATION ERROR:", err);
      }
    }

    // =========================
    // 7. RESPONSE
    // =========================
    return res.json({ success: true, deleted: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({ error: message });
    }

    console.error("[comments] DELETE error:", err);

    return res.status(500).json({
      error: "Delete failed",
    });
  }
};
