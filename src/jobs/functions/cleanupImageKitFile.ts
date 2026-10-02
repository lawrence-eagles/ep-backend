import { and, eq, or, isNull, lt, sql } from "drizzle-orm";
import type { InngestFunction } from "inngest";

import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { imagekitCleanup } from "../../db/schema";
import { deleteImageKitFile } from "../../lib/imageKit";

// A cleanup worker owns a job for 10 minutes.
const CLEANUP_LOCK_MINUTES = 10;

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
         * onFailure receives the Inngest failure event.
         *
         * The original event is available at:
         *
         * event.data.event
         *
         * Its data contains the cleanupId that
         * originally triggered this function.
         */
        const originalEvent = event.data.event as {
          data?: {
            cleanupId?: unknown;
          };
        };

        const cleanupId = originalEvent.data?.cleanupId;

        if (typeof cleanupId !== "string" || cleanupId.length === 0) {
          console.error(
            "ImageKit cleanup failure could not be recorded: invalid cleanupId",
            {
              error,
            },
          );

          return;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);

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
            ),
          );
      });
    },
  },

  async ({ event, step }) => {
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

    // Another worker already owns this job,
    // or it was already completed/failed.
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
