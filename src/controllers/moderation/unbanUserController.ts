import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db";

const paramsSchema = z.object({
  userId: z.string().trim().min(1).max(256),
});

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});

class UserNotFoundError extends Error {
  constructor() {
    super("USER_NOT_FOUND");
  }
}

class UserNotBannedError extends Error {
  constructor() {
    super("USER_NOT_BANNED");
  }
}

export async function unbanUserController(
  req: Request,
  res: Response,
): Promise<Response> {
  const moderatorId = req.user?.id;

  if (!moderatorId) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const parsedParams = paramsSchema.safeParse(req.params);

  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Invalid user ID",
      details: z.treeifyError(parsedParams.error),
    });
  }

  const parsedBody = bodySchema.safeParse(req.body);

  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: z.treeifyError(parsedBody.error),
    });
  }

  const { userId } = parsedParams.data;
  const { reason } = parsedBody.data;

  try {
    await db.transaction(async (tx) => {
      // Use the same advisory lock as the ban controller.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`comment-ban:${userId}`}, 0)
        )
      `);

      const targetUser = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM "user"
        WHERE id = ${userId}
        LIMIT 1
      `);

      if (targetUser.rows.length === 0) {
        throw new UserNotFoundError();
      }

      const deletedBan = await tx.execute<{ user_id: string }>(sql`
        DELETE FROM user_comment_bans
        WHERE user_id = ${userId}
          AND (
            expires_at IS NULL
            OR expires_at > NOW()
          )
        RETURNING user_id
      `);

      if (deletedBan.rows.length === 0) {
        throw new UserNotBannedError();
      }

      // Preserve the unban event in moderation history.
      await tx.execute(sql`
        INSERT INTO moderation_actions (
          moderator_id,
          action_type,
          target_type,
          target_id,
          reason,
          metadata
        )
        VALUES (
          ${moderatorId},
          'user_comment_unbanned',
          'user',
          ${userId},
          ${reason},
          ${JSON.stringify({
            restriction: "comment_access",
          })}::jsonb
        )
      `);
    });

    return res.status(200).json({
      message: "User's comment restriction has been removed",
      userId,
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    if (error instanceof UserNotBannedError) {
      return res.status(404).json({
        error: "User does not have an active comment restriction",
      });
    }

    console.error("unbanUserController error:", error);

    return res.status(500).json({
      error: "Failed to remove user comment restriction",
    });
  }
}
