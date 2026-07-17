import { db } from "../db";
import { follows } from "../db/schema";
import { eq } from "drizzle-orm";

/**
 * Get all users following a category
 *
 * Production features:
 * - Uses indexed lookup (categoryId)
 * - Minimal select (userId only)
 * - Safe error handling
 * - Optional limit for batching
 */
export async function getFollowers(
  categoryId: string,
  options?: {
    limit?: number;
    offset?: number;
  },
): Promise<{ id: string }[]> {
  const limit = options?.limit ?? 1000; // safety cap
  const offset = options?.offset ?? 0;

  try {
    const rows = await db
      .select({
        id: follows.userId,
      })
      .from(follows)
      .where(eq(follows.categoryId, categoryId))
      .limit(limit)
      .offset(offset);

    return rows;
  } catch (error) {
    console.error("getFollowers ERROR:", error);

    // NEVER break pipeline
    return [];
  }
}
