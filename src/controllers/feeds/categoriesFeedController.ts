import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";
import { db } from "../../db";
import { z } from "zod";

const PAGE_SIZE = 20;

// =========================
// 🔒 VALIDATION
// =========================
const paramsSchema = z.object({
  categoryId: z.uuid(),
});

// =========================
// 🔁 CURSOR TYPES
// =========================
type Cursor = {
  createdAt: string;
  id: string;
};

// ✅ FIX: strict cursor validation
const cursorSchema = z.object({
  createdAt: z.string().refine((val) => !Number.isNaN(Date.parse(val)), {
    message: "Invalid createdAt",
  }),
  id: z.uuid(),
});

// =========================
// 🧾 ROW TYPE
// =========================
interface CategoryFeedRow extends Record<string, unknown> {
  id: string;
  title: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  url: string;
  created_at: Date | string;
  category_id: string;

  likes_count: number | string;
  comments_count: number | string;

  user_liked: boolean | string;
  user_bookmarked: boolean | string;
}

// =========================
// 🔥 REDIS SAFE
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
// 🔁 CURSOR HELPERS
// =========================
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

  const result = cursorSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error("Invalid cursor");
  }

  return result.data;
}

// =========================
// 🔥 CACHE KEY
// =========================
function buildCategoryFeedKey(
  userId: string,
  categoryId: string,
  cursor: string | null,
  userVersion: string,
  categoryVersion: string,
) {
  return `feed:v1:category:${userId}:${categoryId}:uv${userVersion}:cv${categoryVersion}:${cursor ?? "first"}`;
}

// =========================
// 🚀 CONTROLLER
// =========================
export const categoryFeedVersionOne = async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. AUTH
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = (req.user as { id: string }).id;

    // =========================
    // 2. PARAM VALIDATION
    // =========================
    const parsedParams = paramsSchema.safeParse(req.params);

    if (!parsedParams.success) {
      return res.status(400).json({
        error: "Invalid categoryId",
      });
    }

    const { categoryId } = parsedParams.data;
    const cursorParam = (req.query.cursor as string) || null;

    // =========================
    // 3. REDIS CACHE
    // =========================
    const redis = await getRedisSafe();

    let cacheKey: string | null = null;

    if (redis) {
      const userVersion =
        (await redis.get(`category_feed:${userId}:version`)) ?? "1";

      const categoryVersion =
        (await redis.get(`category:${categoryId}:version`)) ?? "1";

      cacheKey = buildCategoryFeedKey(
        userId,
        categoryId,
        cursorParam,
        userVersion,
        categoryVersion,
      );

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
    // 4. CURSOR
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
    // 5. QUERY
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

        p.likes_count,
        p.comments_count,

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

      WHERE p.category_id = ${categoryId}

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

      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${PAGE_SIZE + 1}
    `;

    const result = await db.execute<CategoryFeedRow>(query);
    const rows = result.rows;

    // =========================
    // 6. PAGINATION
    // =========================
    const hasNextPage = rows.length > PAGE_SIZE;
    const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;

    // =========================
    // 7. MAP RESPONSE
    // =========================
    const items = pageRows.map((p) => {
      const createdAt =
        p.created_at instanceof Date ? p.created_at : new Date(p.created_at);

      return {
        id: p.id,
        title: p.title,
        slug: p.slug,

        imageUrl: p.image_url,
        summary: p.description,
        sourceUrl: p.url,

        createdAt: createdAt.toISOString(),

        likesCount: Number(p.likes_count) || 0,
        commentsCount: Number(p.comments_count) || 0,

        isLiked: p.user_liked === true || p.user_liked === "t",
        isBookmarked: p.user_bookmarked === true || p.user_bookmarked === "t",
      };
    });

    // =========================
    // 8. NEXT CURSOR
    // =========================
    let nextCursor: string | null = null;

    if (hasNextPage) {
      const last = pageRows[pageRows.length - 1];

      const createdAt =
        last.created_at instanceof Date
          ? last.created_at
          : new Date(last.created_at);

      nextCursor = encodeCursor({
        createdAt: createdAt.toISOString(),
        id: last.id,
      });
    }

    const response = { items, nextCursor };

    // =========================
    // 9. CACHE WRITE
    // =========================
    if (redis && cacheKey) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), {
          EX: 300,
        });
      } catch (err) {
        console.error("REDIS WRITE ERROR:", err);
      }
    }

    return res.json(response);
  } catch (err) {
    console.error("CATEGORY FEED ERROR:", err);
    return res.status(500).json({ error: "Category feed failed" });
  }
};
