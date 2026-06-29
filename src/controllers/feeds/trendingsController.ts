import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";
import { db } from "../../db";
import { buildTrendingKey } from "../../utils/cache";

const PAGE_SIZE = 20;
const CACHE_TTL = 30;
const TRENDING_WINDOW_DAYS = 7;
const MAX_CURSOR_AGE_MS = 15 * 60 * 1000;
const MAX_CURSOR_FUTURE_SKEW_MS = 30 * 1000;

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
// 🔐 CURSOR
// =========================
type Cursor = {
  score: string; // keep as string for precision
  createdAt: string;
  id: string;
  snapshotTime: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    throw new Error("Invalid cursor");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid cursor");
  }

  const c = parsed as Record<string, unknown>;

  if (
    typeof c.score !== "string" ||
    !Number.isFinite(Number(c.score)) ||
    typeof c.createdAt !== "string" ||
    Number.isNaN(Date.parse(c.createdAt)) ||
    typeof c.id !== "string" ||
    !UUID_RE.test(c.id) ||
    typeof c.snapshotTime !== "string" ||
    Number.isNaN(Date.parse(c.snapshotTime))
  ) {
    throw new Error("Invalid cursor");
  }

  return c as Cursor;
}

// =========================
// 🧾 ROW TYPE
// =========================
interface TrendingRow {
  [key: string]: unknown;

  id: string;
  title: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  url: string;
  created_at: Date;
  category_id: string | null;
  source_id: string | null;
  category_name: string | null;
  source_name: string | null;
  source_website: string | null;
  likes_count: number | string;
  comments_count: number | string;
  trend_score: number | string;
  user_liked: boolean | string;
  user_bookmarked: boolean | string;
}

// =========================
// 🚀 CONTROLLER
// =========================
export const trendingFeedVersionOne = async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. AUTH
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;
    const cursorParam = (req.query.cursor as string) || null;

    // =========================
    // 2. CURSOR
    // =========================
    let cursor: Cursor | null = null;

    if (cursorParam) {
      try {
        cursor = decodeCursor(cursorParam);
        const snapshotMs = Date.parse(cursor.snapshotTime);
        const nowMs = Date.now();

        if (
          snapshotMs < nowMs - MAX_CURSOR_AGE_MS ||
          snapshotMs > nowMs + MAX_CURSOR_FUTURE_SKEW_MS
        ) {
          return res.status(400).json({ error: "Invalid cursor" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // =========================
    // 3. SNAPSHOT TIME (FIXED)
    // =========================
    const snapshotTime = cursor
      ? cursor.snapshotTime
      : new Date().toISOString();

    // =========================
    // 4. REDIS
    // =========================
    const redis = await getRedisSafe();
    let cacheKey: string | null = null;

    if (redis) {
      cacheKey = await buildTrendingKey(userId, cursorParam);
    }

    // =========================
    // CACHE READ
    // =========================
    if (!cursorParam && redis && cacheKey) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);

            if (
              !parsed ||
              typeof parsed !== "object" ||
              !Array.isArray((parsed as any).items) ||
              !(parsed as any).items.every(
                (item: any) =>
                  item &&
                  typeof item === "object" &&
                  typeof item.id === "string" &&
                  typeof item.createdAt === "string",
              ) ||
              !("nextCursor" in parsed) ||
              ((parsed as any).nextCursor !== null &&
                typeof (parsed as any).nextCursor !== "string")
            ) {
              throw new Error("Invalid cache shape");
            }

            if ((parsed as any).nextCursor !== null) {
              decodeCursor((parsed as any).nextCursor);
            }
            return res.json(parsed);
          } catch (err) {
            console.warn("Corrupted cache:", cacheKey);

            try {
              await redis.del(cacheKey);
            } catch (delErr) {
              console.error("REDIS DEL ERROR:", delErr);
            }
          }
        }
      } catch (err) {
        console.error("REDIS GET ERROR:", err);
      }
    }

    // =========================
    // 5. QUERY (SNAPSHOT SAFE)
    // =========================
    const query = sql`
      WITH scored_posts AS (
        SELECT
          p.id,
          p.title,
          p.slug,
          p.image_url,
          p.description,
          p.url,
          p.created_at,
          p.category_id,
          p.source_id,

          p.likes_count,
          p.comments_count,

          c.name AS category_name,
          s.name AS source_name,
          s.url  AS source_website,

          (
            (COALESCE(p.score, 0) * 3)
            - EXTRACT(EPOCH FROM ${snapshotTime}::timestamp - p.created_at) * 0.0001
          ) AS trend_score

        FROM posts p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN sources s ON s.id = p.source_id

        -- 🔥 FIXED: snapshot-based window
        WHERE p.created_at > ${snapshotTime}::timestamp - INTERVAL '${sql.raw(
          String(TRENDING_WINDOW_DAYS),
        )} days'
      )

      SELECT
        sp.*,

        EXISTS (
          SELECT 1 FROM likes l
          WHERE l.post_id = sp.id
            AND l.user_id = ${userId}
        ) AS user_liked,

        EXISTS (
          SELECT 1 FROM bookmarks b
          WHERE b.post_id = sp.id
            AND b.user_id = ${userId}
        ) AS user_bookmarked

      FROM scored_posts sp

      ${
        cursor
          ? sql`
        WHERE (
          sp.trend_score < ${cursor.score}::float
          OR (
            sp.trend_score = ${cursor.score}::float
            AND sp.created_at < ${cursor.createdAt}::timestamp
          )
          OR (
            sp.trend_score = ${cursor.score}::float
            AND sp.created_at = ${cursor.createdAt}::timestamp
            AND sp.id < ${cursor.id}::uuid
          )
        )
      `
          : sql``
      }

      ORDER BY
        sp.trend_score DESC,
        sp.created_at  DESC,
        sp.id          DESC

      LIMIT ${PAGE_SIZE + 1}
    `;

    const result = await db.execute(query);
    const rows = result.rows as TrendingRow[];

    // =========================
    // 6. PAGINATION
    // =========================
    const hasMore = rows.length > PAGE_SIZE;
    const sliced = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // =========================
    // 7. RESPONSE
    // =========================
    const items = sliced.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,

      imageUrl: p.image_url,
      summary: p.description,
      sourceUrl: p.url,

      createdAt: new Date(p.created_at).toISOString(),

      category: p.category_name,
      categoryId: p.category_id,

      sourceName: p.source_name,
      sourceWebsite: p.source_website,

      likesCount: Number(p.likes_count) || 0,
      commentsCount: Number(p.comments_count) || 0,

      isLiked: p.user_liked === true || p.user_liked === "t",
      isBookmarked: p.user_bookmarked === true || p.user_bookmarked === "t",
    }));

    // =========================
    // 8. NEXT CURSOR (PRECISION SAFE)
    // =========================
    let nextCursor: string | null = null;

    if (hasMore) {
      const last = sliced[sliced.length - 1];

      nextCursor = encodeCursor({
        score: String(last.trend_score), // 🔥 NO ROUNDING
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
        snapshotTime,
      });
    }

    const response = { items, nextCursor };

    // =========================
    // CACHE WRITE
    // =========================
    if (!cursorParam && redis && cacheKey) {
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
    console.error("TRENDING FEED ERROR:", err);
    return res.status(500).json({ error: "Trending feed failed" });
  }
};
