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
  let count: number;

  try {
    count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }
  } catch (err) {
    console.error("RATE LIMIT ERROR:", err);
    // fail open
    return;
  }

  if (count > RATE_LIMIT_MAX) {
    throw new Error("Too many requests");
  }
}

// =========================
// 🚀 CONTROLLER
// =========================
export const deleteCommentVersionOne = async (req: Request, res: Response) => {
  let postId: string | null = null;
  let slug: string | null = null;
  let categoryId: string | null = null;
  let deletedCount = 0;

  try {
    // =========================
    // 1. AUTH
    // =========================
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;

    // =========================
    // 2. PARAM VALIDATION
    // =========================
    let { id } = req.params;

    if (Array.isArray(id)) id = id[0];

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
      // 🔍 Step 1: validate ownership + get post_id
      const base = await tx.execute(sql`
        SELECT post_id
        FROM comments
        WHERE id = ${id}
          AND user_id = ${userId}
        LIMIT 1
      `);

      if (base.rows.length === 0) {
        return;
      }

      const row = base.rows[0] as { post_id: string };
      postId = row.post_id;

      // 🔍 Step 2: get post metadata
      const post = await tx.execute(sql`
        SELECT slug, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (post.rows.length > 0) {
        const p = post.rows[0] as {
          slug: string;
          category_id: string;
        };

        slug = p.slug;
        categoryId = p.category_id;
      }

      // 🔥 Step 3: delete subtree + count it
      const result = await tx.execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id
          FROM comments
          WHERE id = ${id}

          UNION ALL

          SELECT c.id
          FROM comments c
          INNER JOIN subtree s ON c.parent_id = s.id
        ),
        deleted AS (
          DELETE FROM comments
          WHERE id IN (SELECT id FROM subtree)
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted;
      `);

      deletedCount = Number((result.rows[0] as any)?.count ?? 0);

      // 🔥 Step 4: update post counters
      if (postId && deletedCount > 0) {
        await tx.execute(sql`
          UPDATE posts
          SET score = GREATEST(score - ${7 * deletedCount}, 0),
              comments_count = GREATEST(comments_count - ${deletedCount}, 0)
          WHERE id = ${postId}
        `);
      }

      // 🔥 Step 5: update user behavior
      if (categoryId && deletedCount > 0) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - ${7 * deletedCount}, 0)
          WHERE user_id = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // =========================
    // 5. NOT FOUND / NO-OP
    // =========================
    if (!postId || deletedCount === 0) {
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
        multi.incr(`feed:${req.user.id}:version`);
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
    return res.json({
      success: true,
      deleted: true,
      deletedCount,
    });
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
