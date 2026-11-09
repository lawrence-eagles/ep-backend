import type { Request, Response } from "express";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { comments, posts, reports, moderationActions } from "../../db/schema";

import { invalidateModeratedCommentCaches } from "../../utils/cache";

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getModeratorId(req: Request): string | null {
  return req.user?.id ?? null;
}

// ─────────────────────────────────────────────
// SOFT DELETE MODERATED COMMENT
// DELETE /api/v1/moderation/comments/:commentId
// ─────────────────────────────────────────────

const deleteModeratedCommentSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
  reportId: z.uuid().optional(),
});

export const deleteModeratedCommentController = async (
  req: Request,
  res: Response,
) => {
  try {
    // ─────────────────────────────────────────
    // 1. AUTHENTICATION
    // ─────────────────────────────────────────

    const moderatorId = getModeratorId(req);

    if (!moderatorId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    // ─────────────────────────────────────────
    // 2. VALIDATE COMMENT ID
    // ─────────────────────────────────────────

    const commentIdParsed = z.uuid().safeParse(req.params.commentId);

    if (!commentIdParsed.success) {
      return res.status(400).json({
        error: "Invalid comment ID",
      });
    }

    // ─────────────────────────────────────────
    // 3. VALIDATE REQUEST BODY
    // ─────────────────────────────────────────

    const bodyParsed = deleteModeratedCommentSchema.safeParse(req.body);

    if (!bodyParsed.success) {
      return res.status(400).json({
        error: "Invalid deletion request",
        details: z.flattenError(bodyParsed.error),
      });
    }

    const commentId = commentIdParsed.data;
    const { reason, reportId } = bodyParsed.data;

    // ─────────────────────────────────────────
    // 4. DATABASE TRANSACTION
    // ─────────────────────────────────────────

    const result = await db.transaction(async (tx) => {
      // ───────────────────────────────────────
      // 4A. FIND THE COMMENT AND ITS POST
      // ───────────────────────────────────────

      const [initialComment] = await tx
        .select({
          id: comments.id,
          postId: comments.postId,
        })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1);

      if (!initialComment) {
        throw new Error("COMMENT_NOT_FOUND");
      }

      // ───────────────────────────────────────
      // 4B. ACQUIRE POST-LEVEL ADVISORY LOCK
      // ───────────────────────────────────────

      // Comment creation, liking, and moderation deletion
      // must acquire this same lock before modifying
      // comment state.
      //
      // This serializes these operations across Railway
      // replicas connected to the same PostgreSQL database.

      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${initialComment.postId}, 0)
        )
      `);

      // ───────────────────────────────────────
      // 4C. LOCK AND RECHECK THE ROOT COMMENT
      // ───────────────────────────────────────

      const lockedResult = await tx.execute(sql`
        SELECT
          id,
          post_id,
          is_deleted
        FROM comments
        WHERE id = ${commentId}
        FOR UPDATE
      `);

      if (lockedResult.rows.length === 0) {
        throw new Error("COMMENT_NOT_FOUND");
      }

      const lockedComment = lockedResult.rows[0] as {
        id: string;
        post_id: string;
        is_deleted: boolean;
      };

      if (lockedComment.is_deleted) {
        throw new Error("COMMENT_ALREADY_DELETED");
      }

      // ───────────────────────────────────────
      // 4D. GET ASSOCIATED POST INFORMATION
      // ───────────────────────────────────────

      const [post] = await tx
        .select({
          id: posts.id,
          slug: posts.slug,
          categoryId: posts.categoryId,
        })
        .from(posts)
        .where(eq(posts.id, lockedComment.post_id))
        .limit(1);

      if (!post) {
        throw new Error("POST_NOT_FOUND");
      }

      // ───────────────────────────────────────
      // 4E. VALIDATE ASSOCIATED REPORT
      // ───────────────────────────────────────

      if (reportId) {
        const [report] = await tx
          .select({
            id: reports.id,
            targetType: reports.targetType,
            targetId: reports.targetId,
          })
          .from(reports)
          .where(eq(reports.id, reportId))
          .limit(1);

        if (!report) {
          throw new Error("REPORT_NOT_FOUND");
        }

        if (report.targetType !== "comment" || report.targetId !== commentId) {
          throw new Error("REPORT_TARGET_MISMATCH");
        }
      }

      // ───────────────────────────────────────
      // 4F. SOFT-DELETE ROOT COMMENT AND ALL
      //     DESCENDANTS
      // ───────────────────────────────────────

      // The recursive CTE finds:
      // - The selected root comment.
      // - Its direct replies.
      // - Replies to those replies.
      // - Every deeper descendant.
      //
      // UNION prevents duplicate rows and protects
      // against infinite recursion if malformed
      // cyclic parent relationships exist.

      const deletedResult = await tx.execute(sql`
        WITH RECURSIVE comment_tree AS (
          SELECT
            c.id,
            c.parent_id
          FROM comments c
          WHERE c.id = ${commentId}
            AND c.post_id = ${post.id}

          UNION

          SELECT
            child.id,
            child.parent_id
          FROM comments child
          INNER JOIN comment_tree parent
            ON child.parent_id = parent.id
          WHERE child.post_id = ${post.id}
        ),

        updated_comments AS (
          UPDATE comments c
          SET
            is_deleted = TRUE,
            deleted_at = COALESCE(c.deleted_at, NOW()),
            deleted_by = COALESCE(
              c.deleted_by,
              ${moderatorId}
            )
          FROM comment_tree tree
          WHERE c.id = tree.id
            AND c.is_deleted = FALSE
          RETURNING
            c.id,
            c.parent_id
        )

        SELECT
          id,
          parent_id
        FROM updated_comments
      `);

      const deletedComments = deletedResult.rows as Array<{
        id: string;
        parent_id: string | null;
      }>;

      if (deletedComments.length === 0) {
        throw new Error("COMMENT_ALREADY_DELETED");
      }

      // Collect every newly deleted comment ID.
      const deletedIds = deletedComments.map((comment) => comment.id);

      // ───────────────────────────────────────
      // 4G. UPDATE POST COMMENT COUNT
      // ───────────────────────────────────────

      await tx.execute(sql`
        UPDATE posts
        SET comments_count = GREATEST(
          comments_count - ${deletedComments.length},
          0
        )
        WHERE id = ${post.id}
      `);

      // ───────────────────────────────────────
      // 4H. WRITE MODERATION AUDIT ENTRIES
      // ───────────────────────────────────────

      // The supplied report ID belongs only to the
      // root comment that was actually reported.
      //
      // Descendant comments receive independent audit
      // entries without inheriting the root report ID.

      await tx.insert(moderationActions).values(
        deletedComments.map((comment) => ({
          moderatorId,
          actionType: "comment_soft_deleted",
          targetType: "comment",
          targetId: comment.id,
          commentId: comment.id,

          reportId: comment.id === commentId ? (reportId ?? null) : null,

          reason,

          metadata: {
            rootCommentId: commentId,
            postId: post.id,
            parentId: comment.parent_id,
            cascade: comment.id !== commentId,
          },
        })),
      );

      // ───────────────────────────────────────
      // 4I. RESOLVE REPORTS FOR ALL DELETED
      //     COMMENTS AND DESCENDANTS
      // ───────────────────────────────────────

      // A report against any descendant must also be
      // resolved because its reported content has
      // been removed by the cascading deletion.

      const resolvedReports = await tx.execute(sql`
        UPDATE reports
        SET
          status = 'resolved',
          reviewed_by = ${moderatorId},
          reviewed_at = NOW(),
          resolved_at = NOW(),
          resolution_notes = ${reason},
          updated_at = NOW()
        WHERE target_type = 'comment'
          AND target_id IN (${sql.join(
            deletedIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND status IN ('pending', 'in_review')
        RETURNING id
      `);

      // ───────────────────────────────────────
      // 4J. RETURN TRANSACTION RESULTS
      // ───────────────────────────────────────

      return {
        postId: post.id,
        slug: post.slug,
        categoryId: post.categoryId,
        deletedCommentIds: deletedIds,
        deletedCommentCount: deletedComments.length,
        resolvedReportCount: resolvedReports.rows.length,
      };
    });

    // ─────────────────────────────────────────
    // 5. INVALIDATE REDIS CACHES AFTER COMMIT
    // ─────────────────────────────────────────

    await invalidateModeratedCommentCaches({
      postId: result.postId,
      slug: result.slug,
      categoryId: result.categoryId,
      commentIds: result.deletedCommentIds,
    });

    // ─────────────────────────────────────────
    // 6. SUCCESS RESPONSE
    // ─────────────────────────────────────────

    return res.status(200).json({
      success: true,
      message: "Comment and its descendants were successfully removed.",
      deletedCommentCount: result.deletedCommentCount,
      resolvedReportCount: result.resolvedReportCount,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "";

    // ─────────────────────────────────────────
    // 7. ERROR HANDLING
    // ─────────────────────────────────────────

    if (message === "COMMENT_NOT_FOUND") {
      return res.status(404).json({
        error: "Comment not found",
      });
    }

    if (message === "POST_NOT_FOUND") {
      return res.status(404).json({
        error: "Associated post not found",
      });
    }

    if (message === "REPORT_NOT_FOUND") {
      return res.status(404).json({
        error: "Report not found",
      });
    }

    if (message === "REPORT_TARGET_MISMATCH") {
      return res.status(400).json({
        error: "The supplied report does not belong to this comment",
      });
    }

    if (message === "COMMENT_ALREADY_DELETED") {
      return res.status(409).json({
        error: "This comment has already been deleted",
      });
    }

    console.error("SOFT_DELETE_MODERATED_COMMENT_ERROR:", error);

    return res.status(500).json({
      error: "Unable to delete moderated comment",
    });
  }
};
