import { and, eq, or, isNull, lt, sql } from "drizzle-orm";
import type { InngestFunction } from "inngest";

import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { imagekitCleanup } from "../../db/schema";
import { deleteImageKitFile } from "../../lib/imageKit";

// A cleanup worker owns a job for 10 minutes.
const CLEANUP_LOCK_MINUTES = 10;

type OriginalCleanupEvent = {
  data?: {
    cleanupId?: unknown;
  };
};

type FailureEventData = {
  event?: OriginalCleanupEvent;
  run_id?: unknown;
};

const cleanupImageKitFileFunction = inngest.createFunction(
  {
    id: "cleanup-imagekit-file",

    retries: 10,

    triggers: {
      event: "imagekit/cleanup.requested",
    },

    // Runs only after the main function has exhausted
    // all configured retries.
    onFailure: async ({ event, error, step }) => {
      await step.run("mark-cleanup-failed", async () => {
        /*
         * onFailure receives the "inngest/function.failed"
         * system event.
         *
         * event.data.event contains the original event
         * that triggered the failed function.
         *
         * event.data.run_id contains the run ID of the
         * ORIGINAL failed function.
         *
         * The runId passed directly to onFailure would be
         * the run ID of this separate failure-handler run,
         * so it must NOT be used for ownership.
         */
        const failureData = event.data as FailureEventData;

        const originalEvent = failureData.event;

        const cleanupId = originalEvent?.data?.cleanupId;

        const failedRunId = failureData.run_id;

        if (
          typeof cleanupId !== "string" ||
          cleanupId.length === 0 ||
          typeof failedRunId !== "string" ||
          failedRunId.length === 0
        ) {
          console.error(
            "ImageKit cleanup failure could not be recorded: invalid cleanupId or failed run ID",
            {
              cleanupId,
              failedRunId,
              error,
            },
          );

          return;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);

        /*
         * IMPORTANT:
         *
         * Only mark the job as failed if THIS failed
         * Inngest run still owns the cleanup job.
         *
         * If the 10-minute lease expired and another
         * Inngest run claimed the job, claimRunId will
         * contain the newer run's ID. Therefore this
         * UPDATE will affect zero rows and will NOT
         * overwrite the newer run's processing state.
         */
        await db
          .update(imagekitCleanup)
          .set({
            status: "failed",
            lockedUntil: null,
            lastError: errorMessage,
          })
          .where(
            and(
              eq(imagekitCleanup.id, cleanupId),
              eq(imagekitCleanup.status, "processing"),
              eq(imagekitCleanup.claimRunId, failedRunId),
            ),
          );
      });
    },
  },

  async ({ event, step, runId }) => {
    const cleanupId = event.data.cleanupId;

    // ─────────────────────────────────────────
    // STEP 1
    // Atomically claim the cleanup job.
    // ─────────────────────────────────────────

    const claimed = await step.run("claim-cleanup-job", async () => {
      const now = new Date();

      const lockedUntil = new Date(
        now.getTime() + CLEANUP_LOCK_MINUTES * 60 * 1000,
      );

      const [job] = await db
        .update(imagekitCleanup)
        .set({
          status: "processing",

          attempts: sql`${imagekitCleanup.attempts} + 1`,

          lockedUntil,

          /*
           * Record the exact Inngest run that owns
           * this cleanup job.
           *
           * onFailure later uses event.data.run_id
           * to make sure only this run can mark
           * the job as failed.
           */
          claimRunId: runId,

          lastError: null,
        })
        .where(
          and(
            eq(imagekitCleanup.id, cleanupId),

            // Job must be pending...
            or(
              eq(imagekitCleanup.status, "pending"),

              // ...or its previous processing
              // lease has expired.
              and(
                eq(imagekitCleanup.status, "processing"),
                or(
                  isNull(imagekitCleanup.lockedUntil),
                  lt(imagekitCleanup.lockedUntil, now),
                ),
              ),
            ),
          ),
        )
        .returning({
          id: imagekitCleanup.id,
          fileId: imagekitCleanup.fileId,
        });

      return job ?? null;
    });

    /*
     * Another worker already owns this job,
     * or it was already completed/failed.
     */
    if (!claimed) {
      return {
        skipped: true,
      };
    }

    // ─────────────────────────────────────────
    // STEP 2
    // Delete the ImageKit file.
    // ─────────────────────────────────────────

    await step.run("delete-imagekit-file", async () => {
      await deleteImageKitFile(claimed.fileId);
    });

    // ─────────────────────────────────────────
    // STEP 3
    // Mark the cleanup as completed.
    // ─────────────────────────────────────────

    await step.run("mark-cleanup-completed", async () => {
      await db
        .update(imagekitCleanup)
        .set({
          status: "completed",
          processedAt: new Date(),
          lockedUntil: null,
          lastError: null,
        })
        .where(eq(imagekitCleanup.id, claimed.id));
    });

    return {
      success: true,
      cleanupId: claimed.id,
    };
  },
);

export const cleanupImageKitFile: InngestFunction.Any =
  cleanupImageKitFileFunction;
