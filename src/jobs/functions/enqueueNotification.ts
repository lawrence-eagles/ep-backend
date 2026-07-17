import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { queueNotification } from "../../services/notification";

export const enqueueNotification: InngestFunction.Any = inngest.createFunction(
  {
    id: "enqueue-notification",
    triggers: { event: "notification.enqueue" },
  },
  async ({ event }) => {
    const { userId, article } = event.data;

    try {
      await queueNotification(userId, article);
    } catch (err) {
      console.error("QUEUE ERROR:", err);
      throw err; // Allow Inngest to retry the job
    }
  },
);
