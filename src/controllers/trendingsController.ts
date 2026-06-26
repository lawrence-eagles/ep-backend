import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getRedis } from "../lib/redis";
import { db } from "../db";
import { buildTrendingKey } from "../utils/cache";

const PAGE_SIZE = 20;
const CACHE_TTL = 30;

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

// ── Cursor ────────────────────────────────────────────────────────────────────

type Cursor = {
  score: string;
  createdAt: string;
  id: string;
};

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as Cursor;
}

// ── Row type ──────────────────────────────────────────────────────────────────

interface TrendingRow {
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

export const trendingFeedVersionOne = async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. VALIDATION
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;
    const cursorParam = (req.query.cursor as string) || null;

    // =========================
    // 2. REDIS (SAFE + OPTIONAL)
    // =========================
    const redis = await getRedisSafe();

    const cacheKey = await buildTrendingKey(cursorParam);

    // ── CACHE READ (first page only, non-blocking) ────────────────────────────
    if (!cursorParam && redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        console.error("REDIS GET ERROR:", err);
      }
    }

    // ── CURSOR ───────────────────────────────────────────────────────────────
    let cursor: Cursor | null = null;

    if (cursorParam) {
      try {
        cursor = decodeCursor(cursorParam);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // ── QUERY ────────────────────────────────────────────────────────────────
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
            - EXTRACT(EPOCH FROM NOW() - COALESCE(p.created_at, NOW())) * 0.0001
          ) AS trend_score

        FROM posts p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN sources     s ON s.id = p.source_id
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

      LIMIT ${PAGE_SIZE}
    `;

    const result = await db.execute(query);

    // ✅ FIX: safe casting
    const rows = result.rows as unknown as TrendingRow[];

    // ── MAP ─────────────────────────────────────────────────────────────────
    const items = rows.map((p) => ({
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

    // ── NEXT CURSOR ──────────────────────────────────────────────────────────
    let nextCursor: string | null = null;

    if (rows.length === PAGE_SIZE) {
      const last = rows[rows.length - 1];

      nextCursor = encodeCursor({
        score: String(last.trend_score),
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = { items, nextCursor };

    // ── CACHE WRITE (first page only, non-blocking) ───────────────────────────
    if (!cursorParam && redis) {
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
