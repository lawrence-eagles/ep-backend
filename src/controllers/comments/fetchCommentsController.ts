import type { Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";
import { buildCommentsKey } from "../../utils/cache";

// ── Config ─────────────────────────────────────────────
const PAGE_SIZE = 10;
const REPLIES_PAGE_SIZE = 5;
const CACHE_TTL = 60;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 60;

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
// 🚦 RATE LIMIT
// =========================
async function rateLimit(userId: string, keySuffix: string) {
  const redis = await getRedisSafe();
  if (!redis) return;

  const key = `rate:${keySuffix}:${userId}`;
  let count: number;

  try {
    count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }
  } catch (err) {
    console.error("RATE LIMIT ERROR:", err);
    return;
  }

  if (count > RATE_LIMIT_MAX) {
    throw new Error("Too many requests");
  }
}

// =========================
// Cursor Types
// =========================
interface Cursor {
  created_at: string;
  id: string;
}

// =========================
// Encode Cursor
// =========================
function encodeCursor(data: Cursor): string {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

// =========================
// Decode Cursor
// =========================
function decodeCursor(cursor: string): Cursor {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8");

    if (raw.length > 500) throw new Error();

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }

    const { created_at, id } = parsed;

    if (typeof created_at !== "string" || typeof id !== "string") {
      throw new Error();
    }

    if (!UUID_RE.test(id)) {
      throw new Error();
    }

    const date = new Date(created_at);
    if (isNaN(date.getTime())) {
      throw new Error();
    }

    return {
      created_at: date.toISOString(),
      id,
    };
  } catch {
    throw new Error("Invalid cursor");
  }
}

// =========================
// 🚀 CONTROLLER
// =========================
export const fetchCommentsVersionOne = async (req: Request, res: Response) => {
  try {
    const redis = await getRedisSafe();
    const userId = req.user?.id ?? null;

    await rateLimit(userId ?? `ip:${req.ip}`, "fetch_comments");

    const { cursor } = req.query;

    let { postId } = req.params;
    if (Array.isArray(postId)) postId = postId[0];

    if (!postId || !UUID_RE.test(postId)) {
      return res.status(400).json({ error: "Invalid postId" });
    }

    let decodedCursor: Cursor | null = null;

    if (cursor) {
      try {
        decodedCursor = decodeCursor(cursor as string);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    const cacheKey = await buildCommentsKey(
      postId,
      cursor ? (cursor as string) : null,
      userId, // 🔥 important: user-specific because of isLiked
    );

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));
      } catch (err) {
        console.error("REDIS GET ERROR:", err);
      }
    }

    // =========================
    // FETCH COMMENTS + likes
    // =========================
    const commentsQuery = decodedCursor
      ? sql`
        SELECT 
          c.id,
          c.created_at,
          c.content,
          c.user_id,
          c.likes_count,
          EXISTS (
            SELECT 1 FROM comment_likes cl
            WHERE cl.comment_id = c.id
            ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
          ) AS is_liked
        FROM comments c
        WHERE c.post_id = ${postId}
          AND c.parent_id IS NULL
          AND (c.created_at, c.id) < (
            ${decodedCursor.created_at}::timestamp,
            ${decodedCursor.id}::uuid
          )
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${PAGE_SIZE + 1}
      `
      : sql`
        SELECT 
          c.id,
          c.created_at,
          c.content,
          c.user_id,
          c.likes_count,
          EXISTS (
            SELECT 1 FROM comment_likes cl
            WHERE cl.comment_id = c.id
            ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
          ) AS is_liked
        FROM comments c
        WHERE c.post_id = ${postId}
          AND c.parent_id IS NULL
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;

    const result = await db.execute(commentsQuery);

    const hasMore = result.rows.length > PAGE_SIZE;

    const comments = result.rows.slice(0, PAGE_SIZE) as any[];

    if (comments.length === 0) {
      return res.json({ comments: [], nextCursor: null, hasMore: false });
    }

    const ids = comments.map((c) => c.id);

    // =========================
    // FETCH REPLIES + likes
    // =========================
    const repliesResult = await db.execute(sql`
      SELECT
        c.id AS parent_id,
        r.id AS reply_id,
        r.created_at AS reply_created_at,
        r.content AS reply_content,
        r.user_id AS reply_user_id,
        r.likes_count AS reply_likes_count,
        EXISTS (
          SELECT 1 FROM comment_likes cl
          WHERE cl.comment_id = r.id
          ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
        ) AS reply_is_liked
      FROM comments c
      LEFT JOIN LATERAL (
        SELECT id, created_at, content, user_id, likes_count
        FROM comments r
        WHERE r.parent_id = c.id
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT ${REPLIES_PAGE_SIZE + 1}
      ) r ON TRUE
      WHERE c.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);

    const replyMap = new Map<string, { replies: any[]; hasMore: boolean }>();

    for (const row of repliesResult.rows as any[]) {
      const parentId = row.parent_id;

      if (!replyMap.has(parentId)) {
        replyMap.set(parentId, { replies: [], hasMore: false });
      }

      if (!row.reply_id) continue;

      const data = replyMap.get(parentId)!;

      data.replies.push({
        id: row.reply_id,
        created_at: row.reply_created_at,
        content: row.reply_content,
        user_id: row.reply_user_id,
        likesCount: row.reply_likes_count,
        isLiked: row.reply_is_liked,
      });

      if (data.replies.length > REPLIES_PAGE_SIZE) {
        data.hasMore = true;
        data.replies.pop();
      }
    }

    // =========================
    // BUILD RESPONSE
    // =========================
    const enriched = comments.map((c) => {
      const r = replyMap.get(c.id);
      const replies = r?.replies ?? [];

      return {
        id: c.id,
        created_at: c.created_at,
        content: c.content,
        user_id: c.user_id,
        likesCount: c.likes_count,
        isLiked: c.is_liked,
        replies,
        repliesNextCursor:
          r?.hasMore && replies.length > 0
            ? encodeCursor({
                created_at: new Date(
                  replies[replies.length - 1].created_at,
                ).toISOString(),
                id: replies[replies.length - 1].id,
              })
            : null,
        repliesHasMore: r?.hasMore ?? false,
      };
    });

    const last = comments[comments.length - 1];

    const nextCursor = hasMore
      ? encodeCursor({
          created_at: new Date(last.created_at).toISOString(),
          id: last.id,
        })
      : null;

    const response = {
      comments: enriched,
      nextCursor,
      hasMore,
    };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), {
          EX: CACHE_TTL,
        });
      } catch (err) {
        console.error("REDIS SET ERROR:", err);
      }
    }

    return res.json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({ error: message });
    }

    console.error("[comments] FETCH error:", err);

    return res.status(500).json({ error: "Fetch failed" });
  }
};
