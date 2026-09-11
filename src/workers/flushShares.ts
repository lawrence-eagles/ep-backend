import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { shareApps } from "../db/schema";
import { getRedis } from "../lib/redis";

// ─────────────────────────────────────────────
// 🔒 CONFIGURATION
// ─────────────────────────────────────────────

const LOCK_KEY = "lock:flushShares";

// The lock should comfortably exceed the normal runtime of this job.
// If a flush can legitimately run longer than this, use lock renewal
// or increase this value accordingly.
const LOCK_TTL = 300; // 5 minutes

// Redis key containing pending share clicks:
//
//   share:<shareId>:clicks
//
// Example:
//
//   share:019...:clicks
//
const PENDING_KEY_PATTERN = "share:*:clicks";

// When a pending counter is claimed, it is atomically renamed to:
//
//   share:<shareId>:clicks:processing:<batchId>
//
// These keys are deliberately separate from the live counter so that
// new clicks can continue accumulating while the claimed batch is
// being written to PostgreSQL.
const PROCESSING_KEY_PATTERN = "share:*:clicks:processing:*";

// Maximum number of Redis keys to scan per SCAN iteration.
const SCAN_COUNT = 100;

// ─────────────────────────────────────────────
// 🔒 SAFE REDIS INITIALIZER
// ─────────────────────────────────────────────

async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("❌ REDIS INIT ERROR:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// 🔒 DISTRIBUTED LOCK
// ─────────────────────────────────────────────

async function acquireLock(redis: any): Promise<string | null> {
  const token = randomUUID();

  const result = await redis.set(LOCK_KEY, token, {
    NX: true,
    EX: LOCK_TTL,
  });

  if (result !== "OK") {
    return null;
  }

  return token;
}

/**
 * Release the lock only if we still own it.
 *
 * GET followed by DEL is not fully atomic because another process
 * could theoretically acquire the lock between those two commands
 * after the TTL expires.
 *
 * Lua makes the ownership check + delete atomic.
 */
async function releaseLock(redis: any, token: string): Promise<void> {
  try {
    await redis.eval(
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        end

        return 0
      `,
      {
        keys: [LOCK_KEY],
        arguments: [token],
      },
    );
  } catch (err) {
    console.error("❌ Failed to release Redis lock:", err);
  }
}

// ─────────────────────────────────────────────
// 🔍 SHARE KEY PARSING
// ─────────────────────────────────────────────

function getShareIdFromPendingKey(key: string): string | null {
  const parts = key.split(":");

  // Expected:
  //
  // share:<shareId>:clicks
  //
  if (parts.length !== 3) {
    return null;
  }

  if (parts[0] !== "share") {
    return null;
  }

  if (parts[2] !== "clicks") {
    return null;
  }

  return parts[1] || null;
}

function getProcessingKeyInfo(key: string): {
  shareId: string;
  batchId: string;
} | null {
  const parts = key.split(":");

  // Expected:
  //
  // share:<shareId>:clicks:processing:<batchId>
  //
  if (parts.length !== 5) {
    return null;
  }

  if (parts[0] !== "share") {
    return null;
  }

  if (parts[2] !== "clicks") {
    return null;
  }

  if (parts[3] !== "processing") {
    return null;
  }

  const shareId = parts[1];
  const batchId = parts[4];

  if (!shareId || !batchId) {
    return null;
  }

  return {
    shareId,
    batchId,
  };
}

// ─────────────────────────────────────────────
// 🔢 VALIDATE CLICK COUNT
// ─────────────────────────────────────────────

function parseClickCount(value: string | null, key: string): number {
  if (value === null) {
    return 0;
  }

  const count = Number(value);

  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`Invalid click count for Redis key "${key}": ${value}`);
  }

  return count;
}

// ─────────────────────────────────────────────
// 🔐 CLAIM A PENDING COUNTER
// ─────────────────────────────────────────────

/**
 * Atomically moves a live Redis counter into a unique processing key.
 *
 * IMPORTANT:
 *
 * We intentionally do NOT use GETDEL here.
 *
 * Before:
 *
 *   GETDEL
 *      ↓
 *   PostgreSQL UPDATE
 *
 * If PostgreSQL failed, the clicks were permanently lost.
 *
 * Now:
 *
 *   RENAME
 *      ↓
 *   PostgreSQL UPDATE
 *
 * If PostgreSQL fails, the processing key remains in Redis and can
 * be retried by the next invocation.
 *
 * New clicks continue going into the original live key.
 */
async function claimPendingKey(
  redis: any,
  pendingKey: string,
): Promise<{
  processingKey: string;
  shareId: string;
  batchId: string;
} | null> {
  const shareId = getShareIdFromPendingKey(pendingKey);

  if (!shareId) {
    console.warn(`⚠️ Invalid pending Redis key format: ${pendingKey}`);

    return null;
  }

  const batchId = randomUUID();

  const processingKey = `share:${shareId}:clicks:processing:${batchId}`;

  try {
    /**
     * RENAME is atomic in Redis.
     *
     * Therefore there is no GET → DEL race.
     *
     * Once this succeeds, the clicks are safely held by the
     * processing key until PostgreSQL persistence succeeds.
     */
    await redis.rename(pendingKey, processingKey);

    return {
      processingKey,
      shareId,
      batchId,
    };
  } catch (err: any) {
    /**
     * Another operation may have removed/claimed the key between
     * SCAN and RENAME.
     *
     * That is not necessarily an application failure.
     */
    if (
      err?.message?.includes("no such key") ||
      err?.message?.includes("ERR no such key")
    ) {
      return null;
    }

    throw err;
  }
}

// ─────────────────────────────────────────────
// 💾 PERSIST ONE PROCESSING BATCH
// ─────────────────────────────────────────────

async function persistProcessingBatch(
  redis: any,
  processingKey: string,
  shareId: string,
): Promise<void> {
  /**
   * The counter was already claimed by RENAME.
   *
   * New clicks are NOT being added to this key.
   *
   * New clicks are going into:
   *
   *   share:<shareId>:clicks
   *
   * This gives us a stable snapshot for this batch.
   */
  const countStr = await redis.get(processingKey);

  if (countStr === null) {
    /**
     * This can happen if a previous attempt successfully persisted
     * the batch and deleted the processing key before this attempt
     * reached it.
     *
     * There is nothing left to process.
     */
    return;
  }

  const count = parseClickCount(countStr, processingKey);

  if (count === 0) {
    await redis.del(processingKey);
    return;
  }

  /**
   * IMPORTANT:
   *
   * The SQL expression:
   *
   *   clicks = clicks + count
   *
   * is atomic at the PostgreSQL row level.
   *
   * We do not read the existing clicks value into Node.js.
   */
  const result = await db
    .update(shareApps)
    .set({
      clicks: sql`${shareApps.clicks} + ${count}`,
    })
    .where(eq(shareApps.id, shareId))
    .returning({
      id: shareApps.id,
    });

  /**
   * If no share row exists, do NOT delete the Redis processing key.
   *
   * Keeping it allows the problem to be investigated and retried
   * rather than silently losing the clicks.
   */
  if (result.length === 0) {
    throw new Error(
      `Share app "${shareId}" does not exist in PostgreSQL. ` +
        `Redis processing key "${processingKey}" was preserved.`,
    );
  }

  /**
   * PostgreSQL successfully persisted the counter.
   *
   * Now remove the processing key.
   */
  await redis.del(processingKey);

  console.log(`✅ Flushed ${count} clicks for share ${shareId}`);
}

// ─────────────────────────────────────────────
// 🔄 RECOVER PREVIOUS PROCESSING BATCHES
// ─────────────────────────────────────────────

/**
 * Recover batches left behind by an earlier failed invocation.
 *
 * Example:
 *
 *   invocation #1
 *        ↓
 *   RENAME pending → processing
 *        ↓
 *   PostgreSQL fails
 *        ↓
 *   processing key remains
 *
 *   invocation #2
 *        ↓
 *   finds processing key
 *        ↓
 *   retries PostgreSQL
 *
 * This is what prevents the original GETDEL → DB failure → lost
 * clicks problem.
 */
async function recoverProcessingBatches(redis: any): Promise<number> {
  let recovered = 0;
  let failed = false;

  const iterator = redis.scanIterator({
    MATCH: PROCESSING_KEY_PATTERN,
    COUNT: SCAN_COUNT,
  });

  for await (const key of iterator as AsyncIterable<string>) {
    const info = getProcessingKeyInfo(key);

    if (!info) {
      console.warn(`⚠️ Invalid processing Redis key format: ${key}`);

      continue;
    }

    try {
      await persistProcessingBatch(redis, key, info.shareId);

      recovered += 1;
    } catch (err) {
      failed = true;

      console.error(`❌ Failed to recover processing key "${key}"`, err);
    }
  }

  /**
   * We don't immediately throw for one failed processing key because
   * there may be other independent share batches that can still be
   * successfully flushed.
   *
   * At the end, however, the caller needs to know that the job was
   * not completely successful so Inngest can retry it.
   */
  if (failed) {
    throw new Error("One or more Redis processing batches failed to flush.");
  }

  return recovered;
}

// ─────────────────────────────────────────────
// 🔁 FLUSH NEW PENDING COUNTERS
// ─────────────────────────────────────────────

async function flushPendingCounters(redis: any): Promise<number> {
  let flushed = 0;
  let failed = false;

  const iterator = redis.scanIterator({
    MATCH: PENDING_KEY_PATTERN,
    COUNT: SCAN_COUNT,
  });

  for await (const key of iterator as AsyncIterable<string>) {
    /**
     * Make sure this is a real pending counter.
     *
     * This prevents accidentally processing our processing keys,
     * because those have a different format.
     */
    const shareId = getShareIdFromPendingKey(key);

    if (!shareId) {
      console.warn(`⚠️ Invalid pending Redis key format: ${key}`);

      continue;
    }

    try {
      const claimed = await claimPendingKey(redis, key);

      /**
       * The key may have disappeared between SCAN and RENAME.
       *
       * That's okay. Another worker/process may have claimed it.
       */
      if (!claimed) {
        continue;
      }

      await persistProcessingBatch(
        redis,
        claimed.processingKey,
        claimed.shareId,
      );

      flushed += 1;
    } catch (err) {
      failed = true;

      console.error(`❌ Failed to flush Redis key "${key}"`, err);

      /**
       * DO NOT delete the processing key here.
       *
       * If PostgreSQL failed, keeping the processing key is what
       * allows the next Inngest retry to recover the clicks.
       */
    }
  }

  /**
   * Make the overall function fail so Inngest's configured retries
   * are actually triggered.
   */
  if (failed) {
    throw new Error("One or more Redis share counters failed to flush.");
  }

  return flushed;
}

// ─────────────────────────────────────────────
// 🔁 MAIN FLUSH FUNCTION
// ─────────────────────────────────────────────

export async function flushShares(): Promise<void> {
  console.log("🧠 Starting share-click flush...");

  const redis = await getRedisSafe();

  /**
   * Redis being unavailable means the flush could not be performed.
   *
   * IMPORTANT:
   *
   * We throw here instead of returning successfully.
   *
   * Otherwise Inngest would consider the function successful and
   * would not retry it.
   *
   * The actual click counters are still in Redis because this
   * function has not claimed/deleted them.
   */
  if (!redis) {
    throw new Error(
      "Redis is unavailable. Share-click flush was not performed.",
    );
  }

  // ─────────────────────────────────────────────
  // 🔒 ACQUIRE DISTRIBUTED LOCK
  // ─────────────────────────────────────────────

  const lockToken = await acquireLock(redis);

  if (!lockToken) {
    /**
     * Another flush invocation currently owns the lock.
     *
     * This isn't a data-loss condition because the other invocation
     * is responsible for the flush.
     */
    console.warn("⚠️ Another flushShares job is already running. Skipping.");

    return;
  }

  try {
    // ───────────────────────────────────────────
    // ♻️ RECOVER FAILED PREVIOUS BATCHES FIRST
    // ───────────────────────────────────────────

    const recovered = await recoverProcessingBatches(redis);

    if (recovered > 0) {
      console.log(`♻️ Recovered ${recovered} previous share-click batch(es).`);
    }

    // ───────────────────────────────────────────
    // 🔄 FLUSH NEW COUNTERS
    // ───────────────────────────────────────────

    const flushed = await flushPendingCounters(redis);

    console.log(
      `🎉 Share-click flush complete. ` +
        `Processed ${flushed} new batch(es) and ` +
        `recovered ${recovered} previous batch(es).`,
    );
  } catch (err) {
    /**
     * CRITICAL:
     *
     * Do NOT swallow this error.
     *
     * flushShares() must reject so the Inngest function receives the
     * failure and its configured retries can run.
     */
    console.error("❌ Share-click flush failed:", err);

    throw err;
  } finally {
    // ───────────────────────────────────────────
    // 🔓 RELEASE DISTRIBUTED LOCK
    // ───────────────────────────────────────────

    await releaseLock(redis, lockToken);
  }
}
