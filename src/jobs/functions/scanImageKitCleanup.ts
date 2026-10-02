import { and, eq, isNull, lte, lt, or } from "drizzle-orm";
import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { imagekitCleanup } from "../../db/schema";

type ImageKitCleanupJob = {
  id: string;
};

export const scanImageKitCleanup: InngestFunction.Any = inngest.createFunction(
  {
    id: "scan-imagekit-cleanup",

    triggers: {
      cron: "0 0 * * *",
    },
  },

  async ({ step }) => {
    const jobs = await step.run(
      "find-imagekit-cleanups",
      async (): Promise<ImageKitCleanupJob[]> => {
        const now = new Date();

        return db
          .select({
            id: imagekitCleanup.id,
          })
          .from(imagekitCleanup)
          .where(
            or(
              // ─────────────────────────────────────────────
              // Pending jobs that are ready to be processed.
              // ─────────────────────────────────────────────
              and(
                eq(imagekitCleanup.status, "pending"),
                or(
                  isNull(imagekitCleanup.nextAttemptAt),
                  lte(imagekitCleanup.nextAttemptAt, now),
                ),
              ),

              // ─────────────────────────────────────────────
              // Processing jobs whose lease has expired.
              //
              // A NULL lockedUntil is also treated as
              // recoverable so a processing job cannot
              // remain stuck indefinitely.
              // ─────────────────────────────────────────────
              and(
                eq(imagekitCleanup.status, "processing"),
                or(
                  isNull(imagekitCleanup.lockedUntil),
                  lt(imagekitCleanup.lockedUntil, now),
                ),
              ),
            ),
          )
          .limit(100);
      },
    );

    if (jobs.length === 0) {
      return {
        queued: 0,
      };
    }

    await step.run("queue-imagekit-cleanups", async () => {
      await Promise.all(
        jobs.map((job: ImageKitCleanupJob) =>
          inngest.send({
            name: "imagekit/cleanup.requested",
            data: {
              cleanupId: job.id,
            },
          }),
        ),
      );
    });

    return {
      queued: jobs.length,
    };
  },
);
