import { and, asc, eq, gt } from "drizzle-orm";

import { db } from "../db";
import { follows } from "../db/schema";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

export interface GetFollowersOptions {
  /**
   * Maximum number of followers to return.
   *
   * Defaults to 1000 and is capped at MAX_LIMIT.
   */
  limit?: number;

  /**
   * Keyset pagination cursor.
   *
   * This should be the user ID returned as the last item
   * from the previous page.
   */
  cursor?: string;
}

export interface Follower {
  id: string;
}

export interface GetFollowersResult {
  followers: Follower[];
  nextCursor: string | null;
}

/**
 * Get users following a category using keyset pagination.
 *
 * Production characteristics:
 * - Selects only the user ID required by the caller.
 * - Uses keyset/cursor pagination instead of OFFSET pagination.
 * - Uses the existing (category_id, user_id) index.
 * - Avoids increasingly expensive OFFSET queries for large follower sets.
 * - Uses userId as a stable, unique cursor within each category.
 * - Provides deterministic ordering by userId.
 * - Avoids duplicate/skip behavior caused by concurrent row changes
 *   that can occur with OFFSET pagination.
 * - Enforces a safe maximum batch size.
 * - Validates input before querying the database.
 * - Preserves database errors so the caller/Inngest can retry failed work.
 *
 * Pagination strategy:
 *
 *   WHERE category_id = ?
 *     AND user_id > ?
 *   ORDER BY user_id ASC
 *   LIMIT ?
 *
 * The cursor is the last user ID returned by the previous request.
 */
export async function getFollowers(
  categoryId: string,
  options: GetFollowersOptions = {},
): Promise<GetFollowersResult> {
  if (!categoryId.trim()) {
    throw new Error("getFollowers: categoryId is required");
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const cursor = options.cursor?.trim() || undefined;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(
      `getFollowers: limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }

  try {
    const whereClause = cursor
      ? and(eq(follows.categoryId, categoryId), gt(follows.userId, cursor))
      : eq(follows.categoryId, categoryId);

    const rows = await db
      .select({
        id: follows.userId,
      })
      .from(follows)
      .where(whereClause)
      .orderBy(asc(follows.userId))
      .limit(limit);

    const followers: Follower[] = rows;

    const nextCursor =
      rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null;

    return {
      followers,
      nextCursor,
    };
  } catch (error) {
    console.error("getFollowers: database query failed", {
      categoryId,
      limit,
      cursor,
      error,
    });

    throw error;
  }
}
