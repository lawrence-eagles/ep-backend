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
      limit: 100,
      period: "1s",
    },
    triggers: { event: "notification/batch.check" },
  },
  async ({ event, step }) => {
    const { userId } = event.data;

    const redis = await getRedisSafe();
    if (!redis) return;

    const batchKey = `notif:batch:${userId}`;

    // 🧠 Step 1: get and clear batch atomically
    const items = await step.run("get-and-clear-batch", async () => {
      const multi = redis.multi();

      multi.lRange(batchKey, 0, -1);
      multi.del(batchKey);

      const results = await multi.exec();

      if (!results || results.length === 0) return [];

      // ✅ Properly narrow the type
      const firstResult = results[0];

      if (Array.isArray(firstResult)) {
        return firstResult as string[];
      }

      // fallback safety
      return [];
    });

    if (!items.length) return;

    // ✅ Safe JSON parsing
    const articles = items
      .map((i) => {
        try {
          return JSON.parse(i);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { id: string; title: string }[];

    if (!articles.length) return;

    // 🧠 Step 2: create message
    const title = `${articles.length} new articles`;
    const body = articles[0].title;

    // 🧠 Step 3: fetch tokens
    const tokens = await step.run("get-tokens", async () => {
      return db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId));
    });

    if (!tokens.length) return;

    // 🧠 Step 4: send push notifications
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
          error: err?.message ?? "unknown_error",
        });

        // ❌ remove bad token
        if (err?.message === "INVALID_TOKEN") {
          await db.delete(deviceTokens).where(eq(deviceTokens.token, t.token));
        }
      }
    }
  },
);
