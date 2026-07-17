import { serve } from "inngest/express";
import { inngest } from "../lib/inngest";
import { fetchNews } from "../jobs/functions/fetchNews";
import { flushSharesCron } from "../jobs/functions/flushSharesCron";
import { fanoutNotifications } from "../jobs/functions/fanoutNotifications";
import { enqueueNotification } from "../jobs/functions/enqueueNotification";
import { flushBatch } from "../jobs/functions/flushBatchNotification";
import { cleanupDeviceTokens } from "../jobs/functions/cleanupDeviceTokens";

export const inngestHandler = serve({
  client: inngest,
  functions: [
    fetchNews,
    flushSharesCron,
    fanoutNotifications,
    enqueueNotification,
    flushBatch,
    cleanupDeviceTokens,
  ],
});
