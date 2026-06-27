// /utils/cache.ts

import { getRedis } from "../lib/redis";

// ===============================
// 🔥 VERSION HELPERS
// ===============================

async function getVersion(key: string): Promise<string> {
  try {
    const redis = await getRedis();
    const v = await redis.get(key);
    return v ?? "1";
  } catch (err) {
    console.warn(`[cache] getVersion fallback for "${key}"`, err);
    return "1";
  }
}

/**
 * 🔥 Smart version resolver
 * Priority:
 * 1. Specific key (user/post/etc)
 * 2. Global fallback
 * 3. Default "1"
 */
async function getVersionWithFallback(
  primaryKey: string,
  fallbackKey?: string,
): Promise<string> {
  try {
    const redis = await getRedis();
    const primary = await redis.get(primaryKey);
    if (primary) return primary;

    if (fallbackKey) {
      const fallback = await redis.get(fallbackKey);
      if (fallback) return fallback;
    }

    return "1";
  } catch (err) {
    console.warn(
      `[cache] getVersionWithFallback defaulted for "${primaryKey}"`,
      err,
    );
    return "1";
  }
}

// ===============================
// 🔥 POST CACHE
// ===============================

export async function buildPostCacheKey(slug: string): Promise<string> {
  const version = await getVersion(`post:${slug}:version`);
  return `post:slug:${slug}:v${version}`;
}

// ===============================
// 🔥 USER FEED CACHE
// ===============================

export async function buildFeedKey(
  userId: string,
  cursor: string | null,
  versions?: { userVersion?: string | null; globalVersion?: string | null },
): Promise<string> {
  let finalVersion: string;

  // ✅ Use provided versions if available (fast path)
  if (versions?.userVersion || versions?.globalVersion) {
    finalVersion = versions.userVersion ?? versions.globalVersion ?? "1";
  } else {
    // ✅ Use optimized fallback helper
    finalVersion = await getVersionWithFallback(
      `feed:${userId}:version`,
      "feed:global:version",
    );
  }

  return cursor
    ? `feed:${userId}:v${finalVersion}:cursor:${cursor}`
    : `feed:${userId}:v${finalVersion}:start`;
}

// ===============================
// 🔥 TRENDING CACHE
// ===============================

/**
 * Builds a user-safe trending feed cache key.
 *
 * Includes:
 * - versioning (for global invalidation)
 * - userId (prevents cross-user data leaks)
 * - cursor (pagination-aware caching)
 *
 * @param userId - authenticated user id
 * @param cursor - pagination cursor (nullable)
 */
export async function buildTrendingKey(
  userId: string,
  cursor: string | null,
): Promise<string> {
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid userId for cache key");
  }

  // Fetch global version (safe even if Redis fails upstream)
  let version = "0";

  try {
    const v = await getVersion("feed:trending:version");
    if (v) version = v;
  } catch (err) {
    // 🔥 Never break request due to cache version failure
    console.error("VERSION FETCH ERROR:", err);
  }

  // Optional: prevent extremely large keys (defensive)
  const safeCursor =
    cursor && cursor.length < 200 ? cursor : cursor ? "truncated" : null;

  // Final key structure:
  // feed:trending:v{version}:user:{userId}:{start|cursor:<cursor>}
  return safeCursor
    ? `feed:trending:v${version}:user:${userId}:cursor:${safeCursor}`
    : `feed:trending:v${version}:user:${userId}:start`;
}

// ===============================
// 🔥 BOOKMARK CACHE
// ===============================

export async function buildBookmarksKey(
  userId: string,
  cursor: string | null,
): Promise<string> {
  const version = await getVersion(`bookmarks:${userId}:version`);

  return cursor
    ? `feed:bookmarks:${userId}:v${version}:cursor:${cursor}`
    : `feed:bookmarks:${userId}:v${version}:start`;
}

// ===============================
// 🔥 FOLLOWING CACHE
// ===============================

export async function buildFollowingKey(
  userId: string,
  cursor: string | null,
): Promise<string> {
  const version = await getVersion(`following:${userId}:version`);

  return cursor
    ? `feed:following:${userId}:v${version}:cursor:${cursor}`
    : `feed:following:${userId}:v${version}:start`;
}

// ===============================
// 🔥 COMMENTS CACHE
// ===============================

export async function buildCommentsKey(
  postId: string,
  cursor: string | null,
): Promise<string> {
  const version = await getVersion(`comments:${postId}:version`);

  return cursor
    ? `comments:${postId}:v${version}:c:${cursor}`
    : `comments:${postId}:v${version}:start`;
}
