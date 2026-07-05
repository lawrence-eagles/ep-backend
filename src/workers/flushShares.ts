import { sql, eq } from "drizzle-orm";
import { getRedis } from "../lib/redis";
import { shareApps } from "../db/schema";
import { db } from "../db";

// ─────────────────────────────────────────────
// 🔒 SAFE REDIS INITIALIZER
// ─────────────────────────────────────────────
async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// 🔒 DISTRIBUTED LOCK
// ─────────────────────────────────────────────
const LOCK_KEY = "lock:flushShares";
const LOCK_TTL = 60; // seconds

async function acquireLock(redis: any): Promise<string | null> {
  const token = Math.random().toString(36).slice(2);

  const result = await redis.set(LOCK_KEY, token, {
    NX: true,
    EX: LOCK_TTL,
  });

  if (result !== "OK") return null;

  return token;
}

async function releaseLock(redis: any, token: string) {
  try {
    const current = await redis.get(LOCK_KEY);
    if (current === token) {
      await redis.del(LOCK_KEY);
    }
  } catch (err) {
    console.error("Failed to release lock:", err);
  }
}

// ─────────────────────────────────────────────
// 🔁 FLUSH SHARES (PRODUCTION SAFE)
// ─────────────────────────────────────────────
export async function flushShares(): Promise<void> {
  console.log("🧠 Flushing share clicks...");

  const redis = await getRedisSafe();

  if (!redis) {
    console.warn("⚠️ Redis unavailable — skipping flush job");
    return;
  }

  // 🔒 Acquire lock (prevents overlapping jobs)
  const lockToken = await acquireLock(redis);

  if (!lockToken) {
    console.warn("⚠️ Another flush job is already running — skipping");
    return;
  }

  try {
    const iterator = redis.scanIterator({
      MATCH: "share:*:clicks",
      COUNT: 100,
    });

    for await (const key of iterator as AsyncIterable<string>) {
      try {
        const parts = key.split(":");

        if (parts.length !== 3) {
          console.warn("Invalid key format:", key);
          continue;
        }

        const shareId = parts[1];

        if (!shareId) {
          console.warn("Missing shareId in key:", key);
          continue;
        }

        // 🔥 ATOMIC READ + DELETE (FIXES RACE CONDITION)
        const countStr = await redis.sendCommand(["GETDEL", key]);

        if (!countStr) continue;

        const count = Number(countStr);

        if (!Number.isFinite(count) || count <= 0) {
          console.warn("Invalid count value:", key, countStr);
          continue;
        }

        // 🔥 Persist safely
        await db
          .update(shareApps)
          .set({
            clicks: sql`${shareApps.clicks} + ${count}`,
          })
          .where(eq(shareApps.id, shareId));

        console.log(`✅ Flushed ${shareId}: ${count}`);
      } catch (err) {
        console.error("❌ Flush failed for key:", key, err);
      }
    }

    console.log("🎉 Flush complete");
  } catch (err) {
    console.error("❌ Flush job failed:", err);
  } finally {
    // 🔓 Always release lock
    await releaseLock(redis, lockToken);
  }
}
