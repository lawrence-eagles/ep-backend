import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  comments,
  posts,
  user,
  reports,
  userHiddenComments,
} from "../db/schema";
import { getRedis } from "../lib/redis";

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

const reportSchema = z
  .object({
    targetType: z.enum(["post", "comment", "user"]),
    targetId: z.string().trim().min(1).max(256),

    reason: z.enum([
      "spam",
      "harassment_bullying",
      "hate_speech",
      "violence_dangerous_content",
      "nudity_sexual_content",
      "misinformation",
      "impersonation",
      "inappropriate_content",
      "other",
    ]),

    details: z.string().trim().max(2000).optional(),

    // Only meaningful for comment reports.
    hideComment: z.boolean().default(false),
  })
  .refine(
    (value) => value.targetType === "comment" || value.hideComment === false,
    {
      message: "hideComment is only supported for comment reports",
      path: ["hideComment"],
    },
  );

const uuidSchema = z.uuid();

function getUserId(req: Request): string | null {
  return req.user?.id ?? null;
}

// ─────────────────────────────────────────────
// REDIS RATE LIMIT
// ─────────────────────────────────────────────

async function canSubmitReport(userId: string): Promise<boolean> {
  try {
    const redis = await getRedis();

    if (!redis || !redis.isReady) {
      return true;
    }

    const key = `report:rate:${userId}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60 * 60);
    }

    return count <= 10;
  } catch (error) {
    console.error("REPORT_RATE_LIMIT_ERROR:", error);

    // Fail open so users can still report content during Redis outages.
    return true;
  }
}

// ─────────────────────────────────────────────
// REPORT TARGET VALIDATION
// ─────────────────────────────────────────────

async function getTargetSnapshot(
  targetType: "post" | "comment" | "user",
  targetId: string,
  reporterId: string,
): Promise<string | null | undefined> {
  if (targetType === "post") {
    if (!uuidSchema.safeParse(targetId).success) {
      return undefined;
    }

    const [post] = await db
      .select({
        id: posts.id,
        title: posts.title,
        description: posts.description,
      })
      .from(posts)
      .where(eq(posts.id, targetId))
      .limit(1);

    if (!post) {
      return undefined;
    }

    return JSON.stringify({
      id: post.id,
      title: post.title,
      description: post.description?.slice(0, 1000) ?? null,
    });
  }

  if (targetType === "comment") {
    if (!uuidSchema.safeParse(targetId).success) {
      return undefined;
    }

    const [comment] = await db
      .select({
        id: comments.id,
        content: comments.content,
        postId: comments.postId,
        parentId: comments.parentId,
        userId: comments.userId,
      })
      .from(comments)
      .where(eq(comments.id, targetId))
      .limit(1);

    if (!comment) {
      return undefined;
    }

    return JSON.stringify({
      id: comment.id,
      content: comment.content.slice(0, 2000),
      postId: comment.postId,
      parentId: comment.parentId,
      authorId: comment.userId,
    });
  }

  // User report.
  if (targetId === reporterId) {
    return null;
  }

  const [reportedUser] = await db
    .select({
      id: user.id,
      name: user.name,
    })
    .from(user)
    .where(eq(user.id, targetId))
    .limit(1);

  if (!reportedUser) {
    return undefined;
  }

  return JSON.stringify({
    id: reportedUser.id,
    name: reportedUser.name,
  });
}

// ─────────────────────────────────────────────
// SUBMIT REPORT
// POST /api/v1/reports
// ─────────────────────────────────────────────

export const submitReportController = async (req: Request, res: Response) => {
  try {
    const reporterId = getUserId(req);

    if (!reporterId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const parsed = reportSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid report payload",
        details: z.flattenError(parsed.error),
      });
    }

    const { targetType, targetId, reason, details, hideComment } = parsed.data;

    const allowed = await canSubmitReport(reporterId);

    if (!allowed) {
      return res.status(429).json({
        error: "You have submitted too many reports. Please try again later.",
      });
    }

    const targetSnapshot = await getTargetSnapshot(
      targetType,
      targetId,
      reporterId,
    );

    if (targetSnapshot === undefined) {
      return res.status(404).json({
        error: "The content or user you are reporting could not be found",
      });
    }

    if (targetSnapshot === null) {
      return res.status(400).json({
        error: "You cannot report your own account",
      });
    }

    const result = await db.transaction(async (tx) => {
      const [createdReport] = await tx
        .insert(reports)
        .values({
          reporterId,
          targetType,
          targetId,
          reason,
          details: details ?? null,
          targetSnapshot,
        })
        .onConflictDoNothing()
        .returning({
          id: reports.id,
        });

      // If the same user already reported this target, return the
      // existing report rather than creating a duplicate.
      let reportId = createdReport?.id;

      if (!reportId) {
        const [existingReport] = await tx
          .select({
            id: reports.id,
          })
          .from(reports)
          .where(
            and(
              eq(reports.reporterId, reporterId),
              eq(reports.targetType, targetType),
              eq(reports.targetId, targetId),
            ),
          )
          .limit(1);

        reportId = existingReport?.id;
      }

      if (!reportId) {
        throw new Error("Unable to create or retrieve report");
      }

      // Optional personal hiding preference.
      // This does not delete the comment or block its author.
      if (targetType === "comment" && hideComment) {
        await tx
          .insert(userHiddenComments)
          .values({
            userId: reporterId,
            commentId: targetId,
          })
          .onConflictDoNothing();
      }

      return {
        reportId,
        created: Boolean(createdReport),
      };
    });

    return res.status(result.created ? 201 : 200).json({
      message: result.created
        ? "Report submitted successfully"
        : "You have already reported this content",
      reportId: result.reportId,
      hidden: targetType === "comment" && hideComment,
    });
  } catch (error) {
    console.error("SUBMIT_REPORT_ERROR:", error);

    return res.status(500).json({
      error: "Unable to submit report",
    });
  }
};

// ─────────────────────────────────────────────
// GET MY REPORTS
// GET /api/v1/reports/mine
// ─────────────────────────────────────────────

export const getMyReportsController = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const results = await db
      .select({
        id: reports.id,
        targetType: reports.targetType,
        targetId: reports.targetId,
        reason: reports.reason,
        details: reports.details,
        status: reports.status,
        createdAt: reports.createdAt,
        reviewedAt: reports.reviewedAt,
        resolvedAt: reports.resolvedAt,
        resolutionNotes: reports.resolutionNotes,
      })
      .from(reports)
      .where(eq(reports.reporterId, userId))
      .orderBy(desc(reports.createdAt), desc(reports.id));

    return res.status(200).json({
      reports: results,
    });
  } catch (error) {
    console.error("GET_MY_REPORTS_ERROR:", error);

    return res.status(500).json({
      error: "Unable to retrieve your reports",
    });
  }
};
