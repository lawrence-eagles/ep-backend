import { serve } from "inngest/express";
import { inngest } from "../lib/inngest";
import { fetchNews } from "../jobs/functions/fetchNews";
import { flushSharesCron } from "../jobs/functions/flushSharesCron";

export const inngestHandler = serve({
  client: inngest,
  functions: [fetchNews, flushSharesCron],
});
