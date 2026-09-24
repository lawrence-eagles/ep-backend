import { serve } from "inngest/express";
import { inngest } from "../lib/inngest";
import { fetchNews } from "../jobs/functions/fetchNews";
import { flushSharesCron } from "../jobs/functions/flushSharesCron";
import { fanoutNotifications } from "../jobs/functions/fanoutNotifications";
import { continueFanoutNotifications } from "../jobs/functions/fanoutNotifications";
import { enqueueNotification } from "../jobs/functions/enqueueNotification";
import { flushBatch } from "../jobs/functions/flushBatchNotification";
import { cleanupDeviceTokens } from "../jobs/functions/cleanupDeviceTokens";
import { externalizeUserDeletion } from "../jobs/functions/externalizeUserDeletion";

export const inngestHandler = serve({
  client: inngest,
  functions: [
    fetchNews,
    externalizeUserDeletion,
    flushSharesCron,
    fanoutNotifications,
    continueFanoutNotifications,
    enqueueNotification,
    flushBatch,
    cleanupDeviceTokens,
  ],
});
