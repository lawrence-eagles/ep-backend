import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { comments, userHiddenComments } from "../../db/schema";

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

const uuidSchema = z.uuid();

function getUserId(req: Request): string | null {
  return req.user?.id ?? null;
}

// ─────────────────────────────────────────────
// HIDE COMMENT
// POST /api/v1/comments/:commentId/hide
// ─────────────────────────────────────────────

export const hideCommentController = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const parsed = uuidSchema.safeParse(req.params.commentId);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid comment ID",
      });
    }

    const commentId = parsed.data;

    const [comment] = await db
      .select({
        id: comments.id,
      })
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);

    if (!comment) {
      return res.status(404).json({
        error: "Comment not found",
      });
    }

    await db
      .insert(userHiddenComments)
      .values({
        userId,
        commentId,
      })
      .onConflictDoNothing();

    return res.status(200).json({
      message: "Comment hidden successfully",
      commentId,
      hidden: true,
    });
  } catch (error) {
    console.error("HIDE_COMMENT_ERROR:", error);

    return res.status(500).json({
      error: "Unable to hide comment",
    });
  }
};

// ─────────────────────────────────────────────
// UNHIDE COMMENT
// DELETE /api/v1/comments/:commentId/hide
// ─────────────────────────────────────────────

export const unhideCommentController = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    const parsed = uuidSchema.safeParse(req.params.commentId);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid comment ID",
      });
    }

    const commentId = parsed.data;

    await db
      .delete(userHiddenComments)
      .where(
        and(
          eq(userHiddenComments.userId, userId),
          eq(userHiddenComments.commentId, commentId),
        ),
      );

    return res.status(200).json({
      message: "Comment unhidden successfully",
      commentId,
      hidden: false,
    });
  } catch (error) {
    console.error("UNHIDE_COMMENT_ERROR:", error);

    return res.status(500).json({
      error: "Unable to unhide comment",
    });
  }
};
