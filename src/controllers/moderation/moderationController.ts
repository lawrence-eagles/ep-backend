import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { reports, moderatorRoles, user } from "../../db/schema";

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getModeratorId(req: Request): string | null {
  return req.user?.id ?? null;
}

const reportIdSchema = z.uuid();

const reportListQuerySchema = z.object({
  status: z.enum(["pending", "in_review", "resolved", "dismissed"]).optional(),

  targetType: z.enum(["post", "comment", "user"]).optional(),

  limit: z.coerce.number().int().min(1).max(100).default(50),

  offset: z.coerce.number().int().min(0).max(10000).default(0),
});

const updateReportSchema = z.object({
  status: z.enum(["in_review", "resolved", "dismissed"]),

  resolutionNotes: z.string().trim().max(2000).optional(),
});

// ─────────────────────────────────────────────
// GET REPORT QUEUE
// GET /api/v1/moderation/reports
// ─────────────────────────────────────────────

export const getModerationReportsController = async (
  req: Request,
  res: Response,
) => {
  try {
    const parsed = reportListQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid query parameters",
        details: z.flattenError(parsed.error),
      });
    }

    const { status, targetType, limit, offset } = parsed.data;

    const conditions = [];

    if (status) {
      conditions.push(eq(reports.status, status));
    }

    if (targetType) {
      conditions.push(eq(reports.targetType, targetType));
    }

    const results = await db
      .select()
      .from(reports)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(limit)
      .offset(offset);

    return res.status(200).json({
      reports: results,
      pagination: {
        limit,
        offset,
        returned: results.length,
      },
    });
  } catch (error) {
    console.error("GET_MODERATION_REPORTS_ERROR:", error);

    return res.status(500).json({
      error: "Unable to retrieve moderation reports",
    });
  }
};

// ─────────────────────────────────────────────
// GET REPORT DETAILS
// GET /api/v1/moderation/reports/:reportId
// ─────────────────────────────────────────────

export const getModerationReportController = async (
  req: Request,
  res: Response,
) => {
  try {
    const parsed = reportIdSchema.safeParse(req.params.reportId);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid report ID",
      });
    }

    const [report] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, parsed.data))
      .limit(1);

    if (!report) {
      return res.status(404).json({
        error: "Report not found",
      });
    }

    return res.status(200).json({
      report,
    });
  } catch (error) {
    console.error("GET_MODERATION_REPORT_ERROR:", error);

    return res.status(500).json({
      error: "Unable to retrieve report",
    });
  }
};

// ─────────────────────────────────────────────
// UPDATE REPORT STATUS
// PATCH /api/v1/moderation/reports/:reportId
// ─────────────────────────────────────────────

export const updateModerationReportController = async (
  req: Request,
  res: Response,
) => {
  try {
    const moderatorId = getModeratorId(req);

    if (!moderatorId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const idParsed = reportIdSchema.safeParse(req.params.reportId);

    if (!idParsed.success) {
      return res.status(400).json({
        error: "Invalid report ID",
      });
    }

    const bodyParsed = updateReportSchema.safeParse(req.body);

    if (!bodyParsed.success) {
      return res.status(400).json({
        error: "Invalid report update",
        details: z.flattenError(bodyParsed.error),
      });
    }

    const { status, resolutionNotes } = bodyParsed.data;
    const now = new Date();

    const [updated] = await db
      .update(reports)
      .set({
        status,
        reviewedBy: moderatorId,
        reviewedAt: now,
        resolvedAt: status === "in_review" ? null : now,
        resolutionNotes: resolutionNotes ?? null,
        updatedAt: now,
      })
      .where(eq(reports.id, idParsed.data))
      .returning();

    if (!updated) {
      return res.status(404).json({
        error: "Report not found",
      });
    }

    return res.status(200).json({
      message: "Report updated successfully",
      report: updated,
    });
  } catch (error) {
    console.error("UPDATE_MODERATION_REPORT_ERROR:", error);

    return res.status(500).json({
      error: "Unable to update report",
    });
  }
};

// ─────────────────────────────────────────────
// LIST MODERATORS
// GET /api/v1/moderation/roles
// Bootstrap administrators only.
// ─────────────────────────────────────────────

export const getModeratorsController = async (_req: Request, res: Response) => {
  try {
    const results = await db
      .select({
        userId: moderatorRoles.userId,
        name: user.name,
        email: user.email,
        grantedBy: moderatorRoles.grantedBy,
        createdAt: moderatorRoles.createdAt,
      })
      .from(moderatorRoles)
      .innerJoin(user, eq(moderatorRoles.userId, user.id))
      .orderBy(desc(moderatorRoles.createdAt));

    return res.status(200).json({
      moderators: results,
    });
  } catch (error) {
    console.error("GET_MODERATORS_ERROR:", error);

    return res.status(500).json({
      error: "Unable to retrieve moderators",
    });
  }
};

// ─────────────────────────────────────────────
// GRANT MODERATOR ROLE
// POST /api/v1/moderation/roles
// Bootstrap administrators only.
// ─────────────────────────────────────────────

const grantModeratorSchema = z.object({
  userId: z.string().trim().min(1).max(256),
});

export const grantModeratorController = async (req: Request, res: Response) => {
  try {
    const adminId = getModeratorId(req);

    if (!adminId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const parsed = grantModeratorSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request payload",
        details: z.flattenError(parsed.error),
      });
    }

    const { userId } = parsed.data;

    const [targetUser] = await db
      .select({
        id: user.id,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!targetUser) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    const [created] = await db
      .insert(moderatorRoles)
      .values({
        userId,
        grantedBy: adminId,
      })
      .onConflictDoNothing()
      .returning({
        userId: moderatorRoles.userId,
      });

    return res.status(created ? 201 : 200).json({
      message: created
        ? "Moderator role granted successfully"
        : "User is already a moderator",
      userId,
    });
  } catch (error) {
    console.error("GRANT_MODERATOR_ERROR:", error);

    return res.status(500).json({
      error: "Unable to grant moderator role",
    });
  }
};

// ─────────────────────────────────────────────
// REVOKE MODERATOR ROLE
// DELETE /api/v1/moderation/roles/:userId
// Bootstrap administrators only.
// ─────────────────────────────────────────────

export const revokeModeratorController = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = z
      .string()
      .trim()
      .min(1)
      .max(256)
      .safeParse(req.params.userId);

    if (!userId.success) {
      return res.status(400).json({
        error: "Invalid user ID",
      });
    }

    const [removed] = await db
      .delete(moderatorRoles)
      .where(eq(moderatorRoles.userId, userId.data))
      .returning({
        userId: moderatorRoles.userId,
      });

    if (!removed) {
      return res.status(404).json({
        error: "Moderator role not found",
      });
    }

    return res.status(200).json({
      message: "Moderator role revoked successfully",
      userId: removed.userId,
    });
  } catch (error) {
    console.error("REVOKE_MODERATOR_ERROR:", error);

    return res.status(500).json({
      error: "Unable to revoke moderator role",
    });
  }
};
