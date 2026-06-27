import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getRedis } from "../lib/redis";
import { db } from "../db";
import { buildPostCacheKey } from "../utils/cache";

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

// ── Row types ─────────────────────────────────────────────────────────────────

interface PostRow {
  id: string;
  title: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  url: string;
  clicks: number;
  category_id: string | null;
  source_id: string | null;
  likes_count: number | string;
  comments_count: number | string;
  category_name: string | null;
  source_name: string | null;
  source_website: string | null;
}

interface FlagsRow {
  liked: boolean | string;
  bookmarked: boolean | string;
  following: boolean | string;
}

// ── Track click ───────────────────────────────────────────────────────────────

async function trackClick(
  postId: string,
  userId: string | null,
  categoryId: string | null,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE posts
        SET
          clicks = COALESCE(clicks, 0) + 1,
          score  = COALESCE(score, 0)  + 2
        WHERE id = ${postId}
      `);

      if (userId && categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 2)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET score = COALESCE(user_behavior.score, 0) + 2
        `);
      }
    });
  } catch (err) {
    console.error("[trackClick] Failed:", err);
  }
}

function trackClickAsync(
  postId: string,
  userId: string | null,
  categoryId: string | null,
): void {
  void trackClick(postId, userId, categoryId);
}

// ── Controller ────────────────────────────────────────────────────────────────

export const singlePostControllerVersionOne = async (
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

    const rawSlug = req.params.slug;

    if (!rawSlug || Array.isArray(rawSlug)) {
      return res.status(400).json({ error: "Invalid slug" });
    }

    const slug = rawSlug;
    const userId = req.user.id;

    // =========================
    // 2. REDIS (SAFE)
    // =========================
    const redis = await getRedisSafe();
    let cacheKey: string | null = null;

    let basePost: ReturnType<typeof mapPost> | null = null;

    // ── CACHE READ (non-blocking) ────────────────────────────────────────────
    if (redis) {
      try {
        const cacheKey = await buildPostCacheKey(slug);
        const cached = await redis.get(cacheKey);
        if (cached) {
          basePost = JSON.parse(cached);
        }
      } catch (err) {
        console.error("REDIS GET ERROR:", err);
      }
    }

    // ── DB FETCH ─────────────────────────────────────────────────────────────
    if (!basePost) {
      const result = await db.execute(sql`
        SELECT
          p.id,
          p.title,
          p.slug,
          p.image_url,
          p.description,
          p.url,
          p.clicks,
          p.category_id,
          p.source_id,
          p.likes_count,
          p.comments_count,
          c.name AS category_name,
          s.name AS source_name,
          s.url  AS source_website
        FROM posts p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN sources     s ON p.source_id   = s.id
        WHERE p.slug = ${slug}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Post not found" });
      }

      const p = result.rows[0] as unknown as PostRow;
      basePost = mapPost(p);

      // Cache only semi-hot posts
      if (redis && cacheKey && (p.clicks ?? 0) > 10) {
        try {
          await redis.set(cacheKey, JSON.stringify(basePost), { EX: 300 });
        } catch (err) {
          console.error("REDIS SET ERROR:", err);
        }
      }
    }

    // ── USER FLAGS ───────────────────────────────────────────────────────────
    let isLiked = false;
    let isBookmarked = false;
    let isFollowingCategory = false;

    if (userId && basePost) {
      const flags = await db.execute(sql`
        SELECT
          EXISTS (
            SELECT 1 FROM likes l
            WHERE l.post_id = ${basePost.id}
              AND l.user_id = ${userId}
          ) AS liked,
          EXISTS (
            SELECT 1 FROM bookmarks b
            WHERE b.post_id = ${basePost.id}
              AND b.user_id = ${userId}
          ) AS bookmarked,
          EXISTS (
            SELECT 1 FROM follows f
            WHERE f.category_id = ${basePost.categoryId}
              AND f.user_id     = ${userId}
          ) AS following
      `);

      const f = flags.rows[0] as unknown as FlagsRow;

      isLiked = f?.liked === true || f?.liked === "t";
      isBookmarked = f?.bookmarked === true || f?.bookmarked === "t";
      isFollowingCategory = f?.following === true || f?.following === "t";
    }

    // ── TRACK CLICK (async, non-blocking) ────────────────────────────────────
    if (basePost) {
      trackClickAsync(basePost.id, userId, basePost.categoryId);
    }

    // ── RESPONSE ─────────────────────────────────────────────────────────────
    return res.json({
      ...basePost,
      isLiked,
      isBookmarked,
      isFollowingCategory,
    });
  } catch (err) {
    console.error("GET POST ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapPost(p: PostRow) {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    imageUrl: p.image_url,
    summary: p.description,
    sourceUrl: p.url,

    category: p.category_name,
    categoryId: p.category_id,

    sourceName: p.source_name,
    sourceWebsite: p.source_website,

    clicks: Number(p.clicks) || 0,
    likesCount: Number(p.likes_count) || 0,
    commentsCount: Number(p.comments_count) || 0,
  };
}
