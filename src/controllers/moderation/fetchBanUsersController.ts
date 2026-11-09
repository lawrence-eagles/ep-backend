import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(256).optional(),
});

export async function fetchBannedUsersController(
  req: Request,
  res: Response,
): Promise<Response> {
  if (!req.user?.id) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const parsedQuery = querySchema.safeParse(req.query);

  if (!parsedQuery.success) {
    return res.status(400).json({
      error: "Invalid query parameters",
      details: z.treeifyError(parsedQuery.error),
    });
  }

  const { page, limit, search } = parsedQuery.data;
  const offset = (page - 1) * limit;

  try {
    const searchCondition = search
      ? sql`
          AND (
            u.name ILIKE ${`%${search}%`}
            OR u.email ILIKE ${`%${search}%`}
            OR u.id ILIKE ${`%${search}%`}
          )
        `
      : sql``;

    const [usersResult, countResult] = await Promise.all([
      db.execute<{
        user_id: string;
        name: string;
        email: string;
        image: string | null;
        banned_by: string | null;
        moderator_name: string | null;
        reason: string;
        banned_at: Date;
        expires_at: Date | null;
      }>(sql`
        SELECT
          u.id AS user_id,
          u.name,
          u.email,
          u.image,
          b.banned_by,
          moderator.name AS moderator_name,
          b.reason,
          b.banned_at,
          b.expires_at
        FROM user_comment_bans b
        INNER JOIN "user" u
          ON u.id = b.user_id
        LEFT JOIN "user" moderator
          ON moderator.id = b.banned_by
        WHERE (
          b.expires_at IS NULL
          OR b.expires_at > NOW()
        )
        ${searchCondition}
        ORDER BY b.banned_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `),

      db.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS total
        FROM user_comment_bans b
        INNER JOIN "user" u
          ON u.id = b.user_id
        WHERE (
          b.expires_at IS NULL
          OR b.expires_at > NOW()
        )
        ${
          search
            ? sql`
                AND (
                  u.name ILIKE ${`%${search}%`}
                  OR u.email ILIKE ${`%${search}%`}
                  OR u.id ILIKE ${`%${search}%`}
                )
              `
            : sql``
        }
      `),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    return res.status(200).json({
      users: usersResult.rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        image: row.image,
        bannedBy: row.banned_by,
        moderatorName: row.moderator_name,
        reason: row.reason,
        bannedAt: row.banned_at,
        expiresAt: row.expires_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("fetchBannedUsersController error:", error);

    return res.status(500).json({
      error: "Failed to fetch banned users",
    });
  }
}
