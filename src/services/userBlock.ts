import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";
import { userBlocks } from "../db/schema";

export class UserBlockError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "UserBlockError";
  }
}

/**
 * Block another user.
 */
export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) {
    throw new UserBlockError("You cannot block yourself.", 400);
  }

  // Verify that the target account exists.
  const [targetUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, blockedId))
    .limit(1);

  if (!targetUser) {
    throw new UserBlockError("User not found.", 404);
  }

  // Insert the relationship.
  // Duplicate requests are safe because of the composite primary key.
  await db
    .insert(userBlocks)
    .values({
      blockerId,
      blockedId,
    })
    .onConflictDoNothing({
      target: [userBlocks.blockerId, userBlocks.blockedId],
    });

  return {
    blockerId,
    blockedId,
    isBlocked: true,
  };
}

/**
 * Unblock another user.
 */
export async function unblockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) {
    throw new UserBlockError("Invalid unblock request.", 400);
  }

  const deleted = await db
    .delete(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedId, blockedId),
      ),
    )
    .returning({
      blockedId: userBlocks.blockedId,
    });

  return {
    blockerId,
    blockedId,
    isBlocked: false,
    wasBlocked: deleted.length > 0,
  };
}

/**
 * Retrieve users blocked by the authenticated user.
 */
export async function getBlockedUsers(blockerId: string, limit = 100) {
  return db
    .select({
      userId: userBlocks.blockedId,
      blockedAt: userBlocks.createdAt,
    })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, blockerId))
    .orderBy(desc(userBlocks.createdAt))
    .limit(limit);
}

/**
 * Check whether the authenticated user
 * has blocked a particular user.
 */
export async function getBlockStatus(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) {
    return {
      isBlocked: false,
    };
  }

  const [block] = await db
    .select({
      blockerId: userBlocks.blockerId,
    })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedId, blockedId),
      ),
    )
    .limit(1);

  return {
    isBlocked: Boolean(block),
  };
}
