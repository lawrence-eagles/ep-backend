import type { InngestFunction } from "inngest";

import { inngest } from "../../lib/inngest";
import {
  getFollowers,
  type GetFollowersResult,
} from "../../services/followService";

const BATCH_SIZE = 1000;

export const fanoutNotifications: InngestFunction.Any = inngest.createFunction(
  {
    id: "fanout-notifications",
    triggers: { event: "article.created" },
  },
  async ({ event, step }) => {
    const { categoryId, postId, title, summary, slug } = event.data;

    let cursor: string | undefined;

    while (true) {
      const result: GetFollowersResult = await step.run(
        `get-followers-${postId}-${cursor ?? "initial"}`,
        async (): Promise<GetFollowersResult> => {
          return getFollowers(categoryId, {
            limit: BATCH_SIZE,
            cursor,
          });
        },
      );

      const { followers, nextCursor } = result;

      if (followers.length === 0) {
        break;
      }

      const events = followers.map((user) => ({
        name: "notification.enqueue" as const,
        data: {
          userId: user.id,
          article: {
            id: postId,
            title,
            summary,
            slug,
          },
        },
      }));

      await step.sendEvent(
        `enqueue-notifications-${postId}-${cursor ?? "initial"}`,
        events,
      );

      if (nextCursor === null) {
        break;
      }

      cursor = nextCursor;
    }
  },
);
