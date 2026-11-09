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
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  let count: number;

  try {
    count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }
  } catch (err) {
    console.error("RATE LIMIT ERROR:", err);

    // Fail open if Redis is unavailable.
    return;
  }

  if (count > RATE_LIMIT_MAX) {
    throw new Error("Too many requests");
  }
}

// =========================
// 🚀 CREATE COMMENT CONTROLLER
// =========================
export const createCommentVersionOne = async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. AUTH
    // =========================
    if (!req.user?.id) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const userId = req.user.id;

    // =========================
    // 2. PARAM NORMALIZATION
    // =========================
    let { postId } = req.params;

    if (Array.isArray(postId)) {
      postId = postId[0];
    }

    if (!postId || !UUID_RE.test(postId)) {
      return res.status(400).json({
        error: "Invalid postId",
      });
    }

    const { content, parentId } = req.body;

    // =========================
    // 3. VALIDATION
    // =========================

    // Validate comment content.
    if (typeof content !== "string") {
      return res.status(400).json({
        error: "Missing content",
      });
    }

    const trimmedContent = content.trim();

    if (!trimmedContent) {
      return res.status(400).json({
        error: "Empty comment",
      });
    }

    if (trimmedContent.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({
        error: "Comment too long",
      });
    }

    // Validate parentId without passing non-string values
    // into the UUID regular expression.
    if (
      parentId !== undefined &&
      parentId !== null &&
      (typeof parentId !== "string" || !UUID_RE.test(parentId))
    ) {
      return res.status(400).json({
        error: "Invalid parentId",
      });
    }

    // =========================
    // 4. RATE LIMIT
    // =========================
    await rateLimit(userId, "create_comment");

    let createdComment: Record<string, unknown> | null = null;
    let slug = "";
    let categoryId: string | null = null;

    // =========================
    // 5. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // =========================
      // 5A. USER-LEVEL ADVISORY LOCK
      // =========================
      // Serialize comment creation against ban/unban operations
      // for this user across all API replicas.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`comment-ban:${userId}`}, 0)
        )
      `);

      // Check whether the authenticated user has an active comment restriction.
      const commentBanResult = await tx.execute<{ user_id: string }>(sql`
        SELECT user_id
        FROM user_comment_bans
        WHERE user_id = ${userId}
          AND (
            expires_at IS NULL
            OR expires_at > NOW()
          )
        LIMIT 1
      `);

      if (commentBanResult.rows.length > 0) {
        throw new Error("USER_COMMENT_BANNED");
      }

      // Retrieve the post.
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

      // =========================
      // 5B. POST-LEVEL ADVISORY LOCK
      // =========================
      // Serialize comment creation with moderation deletion
      // for this post across all Railway replicas.
      //
      // This is a transaction-level lock, so PostgreSQL
      // automatically releases it when the transaction ends.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${postId}, 0)
        )
      `);

      // =========================
      // 5C. VALIDATE PARENT COMMENT
      // =========================
      // Allow replies to root comments and nested replies.
      // Reject comments that are deleted or belong to another post.
      if (parentId) {
        const parent = await tx.execute(sql`
          SELECT id
          FROM comments
          WHERE id = ${parentId}
            AND post_id = ${postId}
            AND is_deleted = FALSE
          LIMIT 1
        `);

        if (parent.rows.length === 0) {
          throw new Error("INVALID_PARENT");
        }
      }

      // =========================
      // 5D. INSERT COMMENT
      // =========================
      const insert = await tx.execute(sql`
        INSERT INTO comments (
          content,
          user_id,
          post_id,
          parent_id
        )
        VALUES (
          ${trimmedContent},
          ${userId},
          ${postId},
          ${parentId ?? null}
        )
        RETURNING *
      `);

      if (!insert.rows[0]) {
        throw new Error("INSERT_FAILED");
      }

      createdComment = insert.rows[0] as Record<string, unknown>;

      // =========================
      // 5E. UPDATE POST STATISTICS
      // =========================
      await tx.execute(sql`
        UPDATE posts
        SET
          score = score + 7,
          comments_count = comments_count + 1
        WHERE id = ${postId}
      `);

      // =========================
      // 5F. UPDATE USER BEHAVIOR
      // =========================
      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (
            user_id,
            category_id,
            score
          )
          VALUES (
            ${userId},
            ${categoryId},
            7
          )
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET
            score = user_behavior.score + 7
        `);
      }
    });

    // =========================
    // 6. CACHE INVALIDATION
    // =========================
    const redis = await getRedisSafe();

    if (redis) {
      try {
        const ttl = 60 * 60 * 24 * 30;
        const multi = redis.multi();

        // Comment cache.
        multi.incr(`comments:${postId}:version`);
        multi.expire(`comments:${postId}:version`, ttl);

        // Individual post cache.
        multi.incr(`post:${slug}:version`);
        multi.expire(`post:${slug}:version`, ttl);

        // User feed cache.
        multi.incr(`feed:${userId}:version`);
        multi.expire(`feed:${userId}:version`, ttl);

        // Trending feed cache.
        multi.incr("feed:trending:version");
        multi.expire("feed:trending:version", ttl);

        if (categoryId) {
          // User category feed cache.
          multi.incr(`category_feed:${userId}:version`);
          multi.expire(`category_feed:${userId}:version`, ttl);

          // Global category cache.
          multi.incr(`category:${categoryId}:version`);
          multi.expire(`category:${categoryId}:version`, ttl);
        }

        await multi.exec();
      } catch (err) {
        console.error("[comments] REDIS INVALIDATION ERROR:", err);
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

    if (message === "USER_COMMENT_BANNED") {
      return res.status(403).json({
        error: "You are currently restricted from commenting.",
      });
    }

    if (message === "Too many requests") {
      return res.status(429).json({
        error: message,
      });
    }

    if (message === "POST_NOT_FOUND") {
      return res.status(404).json({
        error: "Post not found",
      });
    }

    if (message === "INVALID_PARENT") {
      return res.status(400).json({
        error: "Invalid parent comment",
      });
    }

    console.error("[comments] CREATE error:", err);

    return res.status(500).json({
      error: "Create failed",
    });
  }
};
