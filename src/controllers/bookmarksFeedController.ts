import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getRedis } from "../lib/redis";
import { db } from "../db";
import { buildBookmarksKey } from "../utils/cache";

const PAGE_SIZE = 20;

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

interface BookmarkRow {
  [key: string]: unknown; // ✅ FIX

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
  user_liked: boolean | string;
  user_bookmarked: boolean | string;
}

export const bookmarksFeedVersionOne = async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. VALIDATION
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;
    const cursorParam = (req.query.cursor as string) || null;

    const cacheKey = await buildBookmarksKey(userId, cursorParam);

    // =========================
    // 2. CACHE (SAFE)
    // =========================
    const redis = await getRedisSafe();

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        console.error("REDIS READ ERROR:", err);
      }
    }

    // =========================
    // 3. CURSOR
    // =========================
    let cursor: Cursor | null = null;

    if (cursorParam) {
      try {
        cursor = decodeCursor(cursorParam);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // =========================
    // 4. QUERY
    // =========================
    const query = sql`
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

        EXISTS (
          SELECT 1 FROM likes l
          WHERE l.post_id = p.id
            AND l.user_id = ${userId}
        ) AS user_liked,

        EXISTS (
          SELECT 1 FROM bookmarks b2
          WHERE b2.post_id = p.id
            AND b2.user_id = ${userId}
        ) AS user_bookmarked

      FROM bookmarks b
      JOIN posts p
        ON p.id = b.post_id

      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sources     s ON s.id = p.source_id

      WHERE b.user_id = ${userId}

      ${
        cursor
          ? sql`
        AND (
          p.created_at < ${cursor.createdAt}::timestamp
          OR (
            p.created_at = ${cursor.createdAt}::timestamp
            AND p.id < ${cursor.id}::uuid
          )
        )
      `
          : sql``
      }

      ORDER BY
        p.created_at DESC,
        p.id DESC

      LIMIT ${PAGE_SIZE}
    `;

    // ✅ FIX: Proper typing (NO unsafe cast)
    const result = await db.execute<BookmarkRow>(query);
    const rows = result.rows;

    // =========================
    // 5. MAP RESPONSE
    // =========================
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

    // =========================
    // 6. NEXT CURSOR
    // =========================
    let nextCursor: string | null = null;

    if (rows.length === PAGE_SIZE) {
      const last = rows[rows.length - 1];

      nextCursor = encodeCursor({
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = { items, nextCursor };

    // =========================
    // 7. CACHE WRITE (SAFE)
    // =========================
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), { EX: 60 });
      } catch (err) {
        console.error("REDIS WRITE ERROR:", err);
      }
    }

    return res.json(response);
  } catch (err) {
    console.error("BOOKMARKS FEED ERROR:", err);
    return res.status(500).json({ error: "Bookmarks feed failed" });
  }
};
