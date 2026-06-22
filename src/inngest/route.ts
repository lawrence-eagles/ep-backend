import { serve } from "inngest/express";
import { inngest } from "../lib/inngest";
import { fetchNews } from "../jobs/fetchNews";

export const inngestHandler = serve({
  client: inngest,
  functions: [fetchNews],
});
