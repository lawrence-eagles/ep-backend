import type { InngestFunction } from "inngest";

import { inngest } from "../../lib/inngest";
import {
  getFollowers,
  type GetFollowersResult,
} from "../../services/followService";

const BATCH_SIZE = 1000;

const CONTINUATION_EVENT = "notification.fanout.continue";

interface ArticleFanoutData {
  categoryId: string;
  postId: string;
  title: string;
  summary: string;
  slug: string;
  cursor?: string;
}

interface NotificationEnqueueEvent {
  name: "notification.enqueue";
  data: {
    userId: string;
    article: {
      id: string;
      title: string;
      summary: string;
      slug: string;
    };
  };
}

interface FanoutContinuationEvent {
  name: typeof CONTINUATION_EVENT;
  data: ArticleFanoutData;
}

async function processFollowerPage(
  data: ArticleFanoutData,
  step: Parameters<Parameters<typeof inngest.createFunction>[1]>[0]["step"],
): Promise<void> {
  const { categoryId, postId, title, summary, slug, cursor } = data;

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
    return;
  }

  const events: NotificationEnqueueEvent[] = followers.map((user) => ({
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

  await step.sendEvent(
    `enqueue-notifications-${postId}-${cursor ?? "initial"}`,
    events,
  );

  if (nextCursor === null) {
    return;
  }

  const continuationEvent: FanoutContinuationEvent = {
    name: CONTINUATION_EVENT,
    data: {
      categoryId,
      postId,
      title,
      summary,
      slug,
      cursor: nextCursor,
    },
  };

  await step.sendEvent(
    `continue-fanout-${postId}-${nextCursor}`,
    continuationEvent,
  );
}

export const fanoutNotifications: InngestFunction.Any = inngest.createFunction(
  {
    id: "fanout-notifications",
    triggers: { event: "article.created" },
  },
  async ({ event, step }) => {
    const { categoryId, postId, title, summary, slug } =
      event.data as ArticleFanoutData;

    await processFollowerPage(
      {
        categoryId,
        postId,
        title,
        summary,
        slug,
      },
      step,
    );
  },
);

export const continueFanoutNotifications: InngestFunction.Any =
  inngest.createFunction(
    {
      id: "continue-fanout-notifications",
      triggers: {
        event: CONTINUATION_EVENT,
      },
    },
    async ({ event, step }) => {
      const { categoryId, postId, title, summary, slug, cursor } =
        event.data as ArticleFanoutData;

      await processFollowerPage(
        {
          categoryId,
          postId,
          title,
          summary,
          slug,
          cursor,
        },
        step,
      );
    },
  );
