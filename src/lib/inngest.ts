import "dotenv/config";
import { Inngest } from "inngest";
import { getEnv } from "./env";

const env = getEnv();

// ── Event Types (TYPE SAFE) ──────────────────────────────────────────────

type Events = {
  "post.created": {
    data: {
      postId: string;
      userId?: string;
    };
  };

  "comment.created": {
    data: {
      commentId: string;
      postId: string;
      userId: string;
    };
  };

  "feed.fetch.requested": {
    data: {
      trigger: "manual" | "cron";
    };
  };
};

// ── Inngest Client ───────────────────────────────────────────────────────

export const inngest = new Inngest({
  id: "news-app", // unique app id
  name: "News Aggregator",

  // Optional but recommended
  eventKey: env.INNGEST_EVENT_KEY,

  // Strong typing for events
  schemas: {
    events: {} as Events,
  },
});
