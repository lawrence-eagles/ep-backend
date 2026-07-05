import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { flushShares } from "../../workers/flushShares";

// ─────────────────────────────────────────────
// 🔧 FUNCTION CONFIG
// ─────────────────────────────────────────────
const FUNCTION_ID = "flush-shares-cron";

/**
 * 🧠 Flush Share Clicks Every 5 Minutes
 *
 * - Uses Inngest cron (no HTTP route required)
 * - Safe in distributed environments
 * - Redis lock prevents double execution
 */
export const flushSharesCron: InngestFunction.Any = inngest.createFunction(
  {
    id: FUNCTION_ID,
    name: "Flush Share Clicks Cron",

    // 🔥 Prevent overlapping executions at Inngest level
    concurrency: {
      limit: 1,
    },

    // 🔁 Retry on failure
    retries: 3,

    // ⏱️ Correct timeout config (FIXED)
    timeouts: {
      start: "55s",
    },

    // ⏰ Cron trigger
    triggers: {
      cron: "*/5 * * * *", // every 5 minutes
    },
  },

  async ({ step, logger }) => {
    logger.info("🧠 Starting flushShares cron job");

    await step.run("flush-shares-job", async () => {
      try {
        await flushShares();
      } catch (err) {
        logger.error("❌ flushShares failed", { error: err });

        // 🔥 IMPORTANT: rethrow for retry
        throw err;
      }
    });

    logger.info("🎉 flushShares cron job completed");
  },
);
