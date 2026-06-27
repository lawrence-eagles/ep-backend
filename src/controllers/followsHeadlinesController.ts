import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getRedis } from "../lib/redis";
import { db } from "../db";
import { buildFollowingKey } from "../utils/cache";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string): Cursor {
  const decoded = JSON.parse(
    Buffer.from(raw, "base64url").toString("utf-8"),
  ) as unknown;

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid cursor");
  }

  const candidate = decoded as Record<string, unknown>;

  if (
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    typeof candidate.id !== "string" ||
    !UUID_RE.test(candidate.id)
  ) {
    throw new Error("Invalid cursor");
  }

  return {
    createdAt: candidate.createdAt,
    id: candidate.id,
  };
}

// ── Row type ──────────────────────────────────────────────────────────────────

interface FollowingRow {
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

export const followsHeadlineVersionOne = async (
  req: Request,
  res: Response,
) => {
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
    const cacheKey = await buildFollowingKey(userId, cursorParam);

    // ── CACHE READ ───────────────────────────────────────────────────────────
    if (redis) {
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

    // =========================
    // 🔥 QUERY (N + 1)
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
          SELECT 1 FROM bookmarks b
          WHERE b.post_id = p.id
            AND b.user_id = ${userId}
        ) AS user_bookmarked

      FROM posts p

      JOIN follows f
        ON f.category_id = p.category_id
       AND f.user_id = ${userId}

      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sources     s ON s.id = p.source_id

      ${
        cursor
          ? sql`
        WHERE (
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

      LIMIT ${PAGE_SIZE + 1}
    `;

    const result = await db.execute(query);
    const rows = result.rows as unknown as FollowingRow[];

    // =========================
    // 🔥 PAGINATION FIX
    // =========================
    const hasNextPage = rows.length > PAGE_SIZE;

    // Only return PAGE_SIZE items
    const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;

    // ── MAP ─────────────────────────────────────────────────────────────────
    const items = pageRows.map((p) => ({
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

    // ── NEXT CURSOR (only if real next page exists) ──────────────────────────
    let nextCursor: string | null = null;

    if (hasNextPage) {
      const last = pageRows[pageRows.length - 1];

      nextCursor = encodeCursor({
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = { items, nextCursor };

    // ── CACHE WRITE ──────────────────────────────────────────────────────────
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), { EX: 60 });
      } catch (err) {
        console.error("REDIS SET ERROR:", err);
      }
    }

    return res.json(response);
  } catch (err) {
    console.error("FOLLOWING FEED ERROR:", err);
    return res.status(500).json({ error: "Following feed failed" });
  }
};
