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
// 🔁 FLUSH SHARES (PRODUCTION SAFE)
// ─────────────────────────────────────────────
export async function flushShares(): Promise<void> {
  console.log("🧠 Flushing share clicks...");

  const redis = await getRedisSafe();

  if (!redis) {
    console.warn("⚠️ Redis unavailable — skipping flush job");
    return;
  }

  try {
    // 🔥 Use SCAN instead of KEYS (non-blocking)
    const iterator = redis.scanIterator({
      MATCH: "share:*:clicks",
      COUNT: 100,
    });

    // ✅ FIX: Explicitly type iterator values
    for await (const key of iterator as AsyncIterable<string>) {
      try {
        // Expected format: share:{shareId}:clicks
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

        // 🔥 ATOMIC READ + DELETE (prevents race condition)
        let countStr: string | null = null;

        try {
          // node-redis supports GETDEL
          countStr = await redis.getDel(key);
        } catch {
          // fallback if GETDEL not available
          countStr = await redis.get(key);
          if (countStr) {
            await redis.del(key);
          }
        }

        if (!countStr) continue;

        const count = Number(countStr);

        if (!Number.isFinite(count) || count <= 0) {
          console.warn("Invalid count value:", key, countStr);
          continue;
        }

        // 🔥 Persist aggregated clicks
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
  }
}
