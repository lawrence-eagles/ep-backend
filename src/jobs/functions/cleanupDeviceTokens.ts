import { lt, inArray } from "drizzle-orm";
import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { deviceTokens } from "../../db/schema";

/**
 * Cleanup stale device tokens (production-safe)
 */
export const cleanupDeviceTokens: InngestFunction.Any = inngest.createFunction(
  {
    id: "cleanup-device-tokens",
    name: "Cleanup stale device tokens",
    concurrency: {
      limit: 1, // ✅ prevent overlapping runs
    },
    triggers: {
      cron: "0 3 * * *", // ✅ daily at 3AM UTC
    },
  },
  async ({ step }) => {
    const BATCH_SIZE = 1000;

    // 🧠 30-day cutoff
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let totalDeleted = 0;
    let iteration = 0;

    while (true) {
      // ✅ STEP 1: Select batch of stale tokens
      const ids = await step.run(`select-batch-${iteration}`, async () => {
        const rows = await db
          .select({ id: deviceTokens.id })
          .from(deviceTokens)
          .where(lt(deviceTokens.lastSeenAt, cutoffDate))
          .limit(BATCH_SIZE);

        return rows.map((r) => r.id);
      });

      if (!ids.length) break;

      // ✅ STEP 2: Delete selected IDs
      const deletedCount = await step.run(
        `delete-batch-${iteration}`,
        async () => {
          await db.delete(deviceTokens).where(inArray(deviceTokens.id, ids));

          return ids.length;
        },
      );

      totalDeleted += deletedCount;

      // 🛑 stop if last batch
      if (ids.length < BATCH_SIZE) break;

      iteration++;
    }

    // 📊 Logging (observability)
    await step.run("log-results", async () => {
      console.log("🧹 Device token cleanup complete", {
        totalDeleted,
        cutoffDate,
      });
    });

    return {
      success: true,
      totalDeleted,
      cutoffDate,
    };
  },
);
