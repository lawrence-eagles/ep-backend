import type { Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";

// ── Config ─────────────────────────────────────────────
const MAX_COMMENT_LENGTH = 2000;
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
export const updateCommentVersionOne = async (req: Request, res: Response) => {
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

    const { content } = req.body;

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

    // =========================
    // 4. RATE LIMIT
    // =========================
    await rateLimit(userId, "update_comment");

    // =========================
    // 5. UPDATE + FETCH POST DATA
    // =========================
    const result = await db.execute(sql`
      UPDATE comments
      SET content = ${trimmedContent}
      WHERE id = ${id}
        AND user_id = ${userId}
      RETURNING post_id
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Comment not found or not owned by user",
      });
    }

    const row = result.rows[0] as { post_id: unknown };

    if (typeof row.post_id !== "string") {
      throw new Error("INVALID_POST_ID");
    }

    const postId = row.post_id;

    // 🔍 Fetch slug for cache consistency
    let slug: string | null = null;

    const postResult = await db.execute(sql`
      SELECT slug FROM posts WHERE id = ${postId} LIMIT 1
    `);

    if (postResult.rows.length > 0) {
      const slugRow = postResult.rows[0] as { slug: unknown };
      if (typeof slugRow.slug === "string") {
        slug = slugRow.slug;
      }
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
    return res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({ error: message });
    }

    console.error("[comments] UPDATE error:", err);

    return res.status(500).json({
      error: "Update failed",
    });
  }
};
