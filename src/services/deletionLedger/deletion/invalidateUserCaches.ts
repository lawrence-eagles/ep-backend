import { getRedis } from "../../../lib/redis";

const REDIS_SCAN_COUNT = 100;
const REDIS_DELETE_BATCH_SIZE = 100;

/**
 * Escapes Redis glob metacharacters so a userId can safely be used
 * inside a SCAN MATCH pattern.
 *
 * Redis glob metacharacters:
 *   *  matches any sequence
 *   ?  matches one character
 *   [ ] character classes
 *   \  escape character
 */
function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?\[\]]/g, "\\$&");
}

/**
 * Deletes all Redis keys belonging specifically to a deleted user.
 *
 * This function is intentionally asynchronous and independent from
 * the PostgreSQL account-deletion transaction.
 *
 * Important:
 * - Uses SCAN instead of KEYS so Redis is not blocked by a large keyspace.
 * - Uses UNLINK instead of DEL so large values are removed asynchronously
 *   by Redis without blocking the main Redis event loop.
 * - Throws Redis errors so the caller (Inngest) can retry.
 * - Is idempotent: deleting a key that no longer exists is harmless.
 * - Does not make PostgreSQL account deletion dependent on Redis.
 *
 * The normal cache TTLs remain a secondary safety mechanism.
 */
export async function invalidateUserCaches(userId: string): Promise<{
  scannedKeys: number;
  deletedKeys: number;
}> {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Cannot invalidate user caches: userId is required.");
  }

  // Keep this implementation exactly as is. It is deliberate and critical
  // for the functionality.
  const redis = await getRedis();

  const safeUserId = escapeRedisGlob(userId);

  /**
   * These patterns cover every user-specific cache namespace currently
   * defined in utils/cache.ts.
   *
   * 1. feed:${userId}:*
   *    - For You feed
   *    - feed:${userId}:version
   *
   * 2. feed:trending:*:user:${userId}:*
   *    - Trending feed pages
   *
   * 3. feed:bookmarks:${userId}:*
   *    - Bookmark feed pages
   *
   * 4. feed:following:${userId}:*
   *    - Following feed pages
   *
   * 5. feed:v1:category:${userId}:*
   *    - Category feed pages
   *
   * 6. comments:*:u:${userId}:*
   *    - User-scoped comment cache entries
   */
  const patterns = [
    `feed:${safeUserId}:*`,
    `feed:trending:*:user:${safeUserId}:*`,
    `feed:bookmarks:${safeUserId}:*`,
    `feed:following:${safeUserId}:*`,
    `feed:v1:category:${safeUserId}:*`,
    `comments:*:u:${safeUserId}:*`,
  ];

  let scannedKeys = 0;
  let deletedKeys = 0;

  for (const pattern of patterns) {
    const keysToDelete: string[] = [];

    try {
      for await (const keyBatch of redis.scanIterator({
        MATCH: pattern,
        COUNT: REDIS_SCAN_COUNT,
      })) {
        const keys: string[] = Array.isArray(keyBatch)
          ? keyBatch.map((key): string => String(key))
          : [String(keyBatch)];

        for (const key of keys) {
          scannedKeys += 1;
          keysToDelete.push(key);

          if (keysToDelete.length >= REDIS_DELETE_BATCH_SIZE) {
            for (const keyToDelete of keysToDelete) {
              deletedKeys += await redis.unlink(keyToDelete);
            }

            keysToDelete.length = 0;
          }
        }
      }

      if (keysToDelete.length > 0) {
        for (const keyToDelete of keysToDelete) {
          deletedKeys += await redis.unlink(keyToDelete);
        }

        keysToDelete.length = 0;
      }
    } catch (error) {
      throw new Error(
        `Failed to invalidate Redis cache for deleted user. ` +
          `UserId=${userId}, Pattern=${pattern}`,
        {
          cause: error,
        },
      );
    }
  }

  return {
    scannedKeys,
    deletedKeys,
  };
}
