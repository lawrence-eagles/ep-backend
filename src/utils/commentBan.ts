import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Checks whether a user currently has an active comment restriction.
 *
 * A NULL expires_at means the restriction is permanent.
 * Expired restrictions are treated as inactive.
 */
export async function isUserCommentBanned(userId: string): Promise<boolean> {
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT user_id
    FROM user_comment_bans
    WHERE user_id = ${userId}
      AND (
        expires_at IS NULL
        OR expires_at > NOW()
      )
    LIMIT 1
  `);

  return result.rows.length > 0;
}
