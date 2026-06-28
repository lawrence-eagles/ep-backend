import type { Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";
import { buildCommentsKey } from "../../utils/cache";

// ── Config ─────────────────────────────────────────────
const PAGE_SIZE = 10;
const REPLIES_PAGE_SIZE = 5;
const CACHE_TTL = 60;

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
// Decode Cursor (HARDENED)
// =========================
function decodeCursor(cursor: string): Cursor {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8");

    if (raw.length > 500) throw new Error(); // prevent abuse

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
// Controller
// =========================
export const fetchCommentsVersionOne = async (req: Request, res: Response) => {
  try {
    const redis = await getRedisSafe();
    const { cursor } = req.query;

    // =========================
    // PARAM VALIDATION
    // =========================
    let { postId } = req.params;

    if (Array.isArray(postId)) postId = postId[0];

    if (!postId || !UUID_RE.test(postId)) {
      return res.status(400).json({ error: "Invalid postId" });
    }

    // =========================
    // CURSOR
    // =========================
    let decodedCursor: Cursor | null = null;

    if (cursor) {
      try {
        decodedCursor = decodeCursor(cursor as string);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // =========================
    // CACHE GET
    // =========================
    const cacheKey = await buildCommentsKey(
      postId,
      cursor ? (cursor as string) : null,
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
    // FETCH TOP-LEVEL COMMENTS
    // =========================
    const commentsQuery = decodedCursor
      ? sql`
        SELECT *
        FROM comments
        WHERE post_id = ${postId}
          AND parent_id IS NULL
          AND (created_at, id) < (
            ${decodedCursor.created_at}::timestamp,
            ${decodedCursor.id}::uuid
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ${PAGE_SIZE + 1}
      `
      : sql`
        SELECT *
        FROM comments
        WHERE post_id = ${postId}
          AND parent_id IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;

    const result = await db.execute(commentsQuery);

    const hasMore = result.rows.length > PAGE_SIZE;

    const comments = result.rows.slice(0, PAGE_SIZE) as Array<{
      id: string;
      created_at: Date;
      [key: string]: any;
    }>;

    if (comments.length === 0) {
      return res.json({ comments: [], nextCursor: null, hasMore: false });
    }

    const ids = comments.map((c) => c.id);

    // =========================
    // FETCH REPLIES (PRODUCTION GRADE)
    // =========================
    const repliesResult = await db.execute(sql`
      SELECT c.*, r.*
      FROM comments c
      LEFT JOIN LATERAL (
        SELECT *
        FROM comments r
        WHERE r.parent_id = c.id
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT ${REPLIES_PAGE_SIZE + 1}
      ) r ON TRUE
      WHERE c.id = ANY(${ids})
    `);

    const replyMap = new Map<
      string,
      {
        replies: any[];
        nextCursor: string | null;
        hasMore: boolean;
      }
    >();

    for (const row of repliesResult.rows as any[]) {
      const parentId = row.id;

      if (!replyMap.has(parentId)) {
        replyMap.set(parentId, {
          replies: [],
          nextCursor: null,
          hasMore: false,
        });
      }

      if (!row.r_id) continue;

      const data = replyMap.get(parentId)!;
      data.replies.push(row);

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

      return {
        ...c,
        replies: r?.replies ?? [],
        repliesNextCursor:
          r?.hasMore && r.replies.length > 0
            ? encodeCursor({
                created_at: new Date(
                  r.replies[r.replies.length - 1].created_at,
                ).toISOString(),
                id: r.replies[r.replies.length - 1].id,
              })
            : null,
        repliesHasMore: r?.hasMore ?? false,
      };
    });

    // =========================
    // NEXT CURSOR
    // =========================
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

    // =========================
    // CACHE SET
    // =========================
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
  } catch (err) {
    console.error("[comments] FETCH error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
};
