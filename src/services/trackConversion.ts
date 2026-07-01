import { db } from "../db";
import { shareConversions } from "../db/schema";
import { getRedis } from "../lib/redis";

// ─────────────────────────────────────────────
// 🔒 SAFE REDIS INITIALIZER (FAIL-SAFE)
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
// 🚀 TRACK CONVERSION (PRODUCTION SAFE)
// ─────────────────────────────────────────────
export async function trackConversion(
  shareId: string,
  userId: string,
  type: "signup" | "open",
): Promise<void> {
  try {
    // ✅ Basic validation (fail fast but safe)
    if (!shareId || !userId || !type) {
      console.warn("Invalid conversion payload", {
        shareId,
        userId,
        type,
      });
      return;
    }

    // ─────────────────────────────────────────
    // 🔥 REDIS (OPTIONAL DEDUPE LAYER)
    // ─────────────────────────────────────────
    const redis = await getRedisSafe();

    let shouldInsert = true;

    if (redis) {
      try {
        const key = `conversion:${shareId}:${userId}:${type}`;

        const exists = await redis.get(key);

        if (exists) {
          shouldInsert = false;
        } else {
          await redis.set(key, "1", { EX: 86400 }); // 24h dedupe window
        }
      } catch (err) {
        console.error("REDIS OPERATION ERROR:", err);
        // fallback → still insert into DB
      }
    }

    // ─────────────────────────────────────────
    // 🗄️ DATABASE WRITE (SOURCE OF TRUTH)
    // ─────────────────────────────────────────
    if (shouldInsert) {
      await db.insert(shareConversions).values({
        shareId,
        userId,
        type,
      });
    }
  } catch (error) {
    // 🔥 NEVER BREAK CALLER FLOW
    console.error("trackConversion failed:", error);
  }
}
