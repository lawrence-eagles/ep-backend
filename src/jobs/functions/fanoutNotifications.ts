import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { getFollowers } from "../../services/followService";

export const fanoutNotifications: InngestFunction.Any = inngest.createFunction(
  { id: "fanout-notifications", triggers: { event: "article.created" } },
  async ({ event, step }) => {
    const { categoryId, postId, title, summary, slug } = event.data;

    await step.run(`fanout-${postId}`, async () => {
      let offset = 0;
      const batchSize = 1000;

      while (true) {
        const followers = await getFollowers(categoryId, {
          limit: batchSize,
          offset,
        });

        if (!followers.length) break;

        const events = followers.map((user) => ({
          name: "notification.enqueue",
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

        await inngest.send(events);

        offset += batchSize;
      }
    });
  },
);
