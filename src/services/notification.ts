import { inngest } from "../lib/inngest";
import { getRedis } from "../lib/redis";

const BATCH_WINDOW = 60; // seconds

// ✅ SAFE WRAPPER (important)
export async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

export async function queueNotification(userId: string, article: any) {
  const redis = await getRedisSafe();

  // 🔒 1. DEDUPE
  if (redis) {
    const dedupeKey = `notif:sent:${userId}:${article.id}`;
    const set = await redis.set(dedupeKey, "1", { EX: 3600, NX: true });

    if (!set) return;
  }

  // 📦 2. BATCH BUFFER (Redis list)
  if (redis) {
    const batchKey = `notif:batch:${userId}`;

    await redis.rPush(batchKey, JSON.stringify(article));

    // set TTL so batch auto flushes
    await redis.expire(batchKey, BATCH_WINDOW);
  }

  // ⚡ 3. TRIGGER INNGEST
  await inngest.send({
    name: "notification/batch.check",
    data: { userId },
  });
}
