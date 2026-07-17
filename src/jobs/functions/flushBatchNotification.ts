import { eq } from "drizzle-orm";
import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { getRedis } from "../../lib/redis";
import { db } from "../../db";
import { deviceTokens, notifications } from "../../db/schema";
import { sendPush } from "../../lib/fcm";

// ✅ SAFE WRAPPER (important)
export async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

export const flushBatch: InngestFunction.Any = inngest.createFunction(
  {
    id: "flush-batch",
    rateLimit: {
      limit: 100, // ✅ global rate limit
      period: "1s",
    },
    triggers: { event: "notification/batch.check" },
  },
  async ({ event, step }) => {
    const { userId } = event.data;

    const redis = await getRedisSafe();
    if (!redis) return;

    const batchKey = `notif:batch:${userId}`;

    // 🧠 Step 1: get batch
    const items = await step.run("get-batch", async () => {
      return await redis.lRange(batchKey, 0, -1);
    });

    if (!items.length) return;

    // 🧠 Step 2: clear batch
    await redis.del(batchKey);

    const articles = items.map((i) => JSON.parse(i));

    // 🧠 Step 3: create message
    const title = `${articles.length} new articles`;
    const body = articles[0].title;

    // 🧠 Step 4: fetch tokens
    const tokens = await step.run("get-tokens", async () => {
      return db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId));
    });

    // 🧠 Step 5: send push
    for (const t of tokens) {
      try {
        await sendPush(t.token, {
          title,
          body,
          data: {
            articleIds: JSON.stringify(articles.map((a) => a.id)),
          },
        });

        await db.insert(notifications).values({
          userId,
          postId: articles[0].id,
          status: "sent",
        });
      } catch (err: any) {
        await db.insert(notifications).values({
          userId,
          postId: articles[0].id,
          status: "failed",
          error: err.message,
        });

        // ❌ remove bad token
        if (err.message === "INVALID_TOKEN") {
          await db.delete(deviceTokens).where(eq(deviceTokens.token, t.token));
        }
      }
    }
  },
);
