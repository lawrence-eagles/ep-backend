import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db";

const paramsSchema = z.object({
  userId: z.string().trim().min(1).max(256),
});

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(2000),

  // Omit or use null for a permanent restriction.
  // Supply an ISO 8601 timestamp for a temporary restriction.
  expiresAt: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .refine(
      (value) => value == null || new Date(value).getTime() > Date.now(),
      {
        message: "Expiration date must be in the future",
      },
    ),
});

class UserNotFoundError extends Error {
  constructor() {
    super("USER_NOT_FOUND");
  }
}

class AlreadyBannedError extends Error {
  constructor() {
    super("USER_ALREADY_BANNED");
  }
}

export async function banUserController(
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
  const { reason, expiresAt } = parsedBody.data;

  if (userId === moderatorId) {
    return res.status(400).json({
      error: "You cannot restrict your own account",
    });
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Serialize ban/unban operations for this user across API replicas.
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

      const existingBan = await tx.execute<{ user_id: string }>(sql`
        SELECT user_id
        FROM user_comment_bans
        WHERE user_id = ${userId}
          AND (
            expires_at IS NULL
            OR expires_at > NOW()
          )
        LIMIT 1
      `);

      if (existingBan.rows.length > 0) {
        throw new AlreadyBannedError();
      }

      const banResult = await tx.execute<{
        user_id: string;
        banned_by: string | null;
        reason: string;
        banned_at: Date;
        expires_at: Date | null;
      }>(sql`
        INSERT INTO user_comment_bans (
          user_id,
          banned_by,
          reason,
          banned_at,
          expires_at
        )
        VALUES (
          ${userId},
          ${moderatorId},
          ${reason},
          NOW(),
          ${expiresAt ? new Date(expiresAt) : null}
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          banned_by = EXCLUDED.banned_by,
          reason = EXCLUDED.reason,
          banned_at = NOW(),
          expires_at = EXCLUDED.expires_at
        WHERE
          user_comment_bans.expires_at IS NOT NULL
          AND user_comment_bans.expires_at <= NOW()
        RETURNING
          user_id,
          banned_by,
          reason,
          banned_at,
          expires_at
      `);

      if (banResult.rows.length === 0) {
        throw new AlreadyBannedError();
      }

      // Record the moderation action in the same transaction.
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
          'user_comment_banned',
          'user',
          ${userId},
          ${reason},
          ${JSON.stringify({
            expiresAt: expiresAt ?? null,
            restriction: "comment_access",
          })}::jsonb
        )
      `);

      return banResult.rows[0];
    });

    return res.status(200).json({
      message: "User has been restricted from comments",
      ban: {
        userId: result.user_id,
        bannedBy: result.banned_by,
        reason: result.reason,
        bannedAt: result.banned_at,
        expiresAt: result.expires_at,
      },
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    if (error instanceof AlreadyBannedError) {
      return res.status(409).json({
        error: "User already has an active comment restriction",
      });
    }

    console.error("banUserController error:", error);

    return res.status(500).json({
      error: "Failed to restrict user",
    });
  }
}
