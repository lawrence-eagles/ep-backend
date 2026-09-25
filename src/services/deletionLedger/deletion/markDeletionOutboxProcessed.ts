import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { deletionOutbox } from "../../../db/schema";

export async function markDeletionOutboxProcessed(
  deletionId: string,
): Promise<void> {
  if (!deletionId || deletionId.trim().length === 0) {
    throw new Error(
      "Cannot mark deletion outbox as processed: deletionId is required.",
    );
  }

  const now = new Date();

  const result = await db
    .update(deletionOutbox)
    .set({
      status: "processed",
      processedAt: now,
      lastError: null,
    })
    .where(
      and(
        eq(deletionOutbox.deletionId, deletionId),
        eq(deletionOutbox.status, "pending"),
      ),
    )
    .returning({
      id: deletionOutbox.id,
      deletionId: deletionOutbox.deletionId,
      status: deletionOutbox.status,
      processedAt: deletionOutbox.processedAt,
    });

  /**
   * If nothing was updated, determine whether:
   *
   * 1. the row doesn't exist, or
   * 2. it was already processed.
   */
  if (result.length === 0) {
    const existing = await db
      .select({
        id: deletionOutbox.id,
        status: deletionOutbox.status,
      })
      .from(deletionOutbox)
      .where(eq(deletionOutbox.deletionId, deletionId))
      .limit(1);

    if (existing.length === 0) {
      throw new Error(
        `Deletion outbox record was not found. ` + `DeletionId=${deletionId}`,
      );
    }

    if (existing[0].status === "processed") {
      /**
       * Idempotent success.
       *
       * The R2 write and/or previous database update already completed.
       */
      return;
    }

    throw new Error(
      `Deletion outbox record exists but could not be marked as processed. ` +
        `DeletionId=${deletionId}, ` +
        `Status=${existing[0].status}`,
    );
  }
}
