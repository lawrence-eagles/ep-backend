import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { RedisClientType } from "redis";

import { db } from "../db";
import { shareApps } from "../db/schema";
import { getRedis } from "../lib/redis";

// ─────────────────────────────────────────────
// 🔒 CONFIGURATION
// ─────────────────────────────────────────────

const LOCK_KEY = "lock:flushShares";

/**
 * The lock should be longer than the normal execution time of the job.
 *
 * If flushShares can legitimately take longer than this, increase the
 * TTL or implement lock renewal.
 */
const LOCK_TTL = 300; // 5 minutes

/**
 * Live Redis counters:
 *
 *   share:<shareId>:clicks
 *
 * Example:
 *
 *   share:019abc...:clicks
 */
const PENDING_KEY_PATTERN = "share:*:clicks";

/**
 * Claimed/processing counters:
 *
 *   share:<shareId>:clicks:processing:<batchId>
 *
 * These are separated from the live counter so new clicks can continue
 * accumulating while the claimed batch is being persisted.
 */
const PROCESSING_KEY_PATTERN = "share:*:clicks:processing:*";

/**
 * Permanently invalid processing keys are quarantined here instead of
 * being deleted silently.
 *
 * This is particularly important when the corresponding shareApps row
 * no longer exists in PostgreSQL.
 */
const QUARANTINE_KEY_PREFIX = "share:clicks:quarantine:";

/**
 * Number of keys Redis should attempt to return per SCAN iteration.
 *
 * NOTE:
 * redis@6 scanIterator() yields arrays/pages of keys.
 */
const SCAN_COUNT = 100;

// ─────────────────────────────────────────────
// 🔒 REDIS TYPE
// ─────────────────────────────────────────────

type RedisClient = RedisClientType;

// ─────────────────────────────────────────────
// 🔒 SAFE REDIS INITIALIZER
// ─────────────────────────────────────────────

async function getRedisSafe(): Promise<RedisClient | null> {
  try {
    return (await getRedis()) as RedisClient;
  } catch (err) {
    console.error("❌ REDIS INIT ERROR:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// 🔒 DISTRIBUTED LOCK
// ─────────────────────────────────────────────

async function acquireLock(redis: RedisClient): Promise<string | null> {
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
 * Release the lock only when we still own it.
 *
 * The GET + DEL operation is performed atomically with Lua so another
 * process cannot acquire the lock between the ownership check and DEL.
 */
async function releaseLock(redis: RedisClient, token: string): Promise<void> {
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

/**
 * Extract the share ID from:
 *
 *   share:<shareId>:clicks
 */
function getShareIdFromPendingKey(key: string): string | null {
  const parts = key.split(":");

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

/**
 * Extract information from:
 *
 *   share:<shareId>:clicks:processing:<batchId>
 */
function getProcessingKeyInfo(key: string): {
  shareId: string;
  batchId: string;
} | null {
  const parts = key.split(":");

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
// 🔢 CLICK COUNT VALIDATION
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
// 🔐 CLAIM PENDING COUNTER
// ─────────────────────────────────────────────

/**
 * Atomically moves a live Redis counter into a unique processing key.
 *
 * IMPORTANT:
 *
 * We intentionally do NOT use GETDEL.
 *
 * Old behavior:
 *
 *   GETDEL
 *      ↓
 *   PostgreSQL UPDATE
 *      ↓
 *   PostgreSQL fails
 *      ↓
 *   clicks LOST
 *
 * New behavior:
 *
 *   RENAME
 *      ↓
 *   processing key
 *      ↓
 *   PostgreSQL UPDATE
 *
 * If PostgreSQL fails, the processing key remains available for a
 * subsequent retry.
 *
 * New clicks continue going to the original live key.
 */
async function claimPendingKey(
  redis: RedisClient,
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
     * Redis RENAME is atomic.
     *
     * Once this succeeds, this particular counter is no longer being
     * modified by incoming share clicks.
     */
    await redis.rename(pendingKey, processingKey);

    return {
      processingKey,
      shareId,
      batchId,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message.toLowerCase()
        : String(err).toLowerCase();

    /**
     * The key may disappear between SCAN and RENAME.
     *
     * That is expected in a distributed system and does not represent
     * a flush failure.
     */
    if (
      message.includes("no such key") ||
      message.includes("key does not exist")
    ) {
      return null;
    }

    throw err;
  }
}

// ─────────────────────────────────────────────
// 🗃️ QUARANTINE TERMINAL FAILURE
// ─────────────────────────────────────────────

/**
 * Move a permanently invalid processing key into a quarantine
 * namespace rather than repeatedly retrying it forever.
 *
 * Example:
 *
 *   share:123:clicks:processing:abc
 *
 * becomes:
 *
 *   share:clicks:quarantine:<uuid>
 *
 * The original Redis value is preserved for investigation.
 */
async function quarantineProcessingKey(
  redis: RedisClient,
  processingKey: string,
  reason: string,
): Promise<void> {
  const quarantineKey = `${QUARANTINE_KEY_PREFIX}${randomUUID()}`;

  try {
    /**
     * RENAME atomically moves the value and preserves its contents.
     */
    await redis.rename(processingKey, quarantineKey);

    /**
     * Store diagnostic metadata separately.
     *
     * This does not affect the click count stored in the quarantined
     * key itself.
     */
    await redis.hSet(`${quarantineKey}:metadata`, {
      originalKey: processingKey,
      reason,
      quarantinedAt: new Date().toISOString(),
    });

    /**
     * Give metadata a long TTL so operational investigation remains
     * possible without allowing metadata to live forever.
     */
    await redis.expire(
      `${quarantineKey}:metadata`,
      60 * 60 * 24 * 30, // 30 days
    );

    console.error(
      `🚨 Quarantined permanently invalid processing key ` +
        `"${processingKey}" as "${quarantineKey}". ` +
        `Reason: ${reason}`,
    );
  } catch (err) {
    /**
     * If quarantine itself fails, preserve the original processing
     * key. It is better to retry than to lose the clicks.
     */
    console.error(
      `❌ Failed to quarantine processing key "${processingKey}". ` +
        `The original key was preserved.`,
      err,
    );

    throw err;
  }
}

// ─────────────────────────────────────────────
// 💾 PERSIST ONE PROCESSING BATCH
// ─────────────────────────────────────────────

type PersistResult =
  | {
      status: "success";
      count: number;
    }
  | {
      status: "missing-share";
      count: number;
      shareId: string;
    };

/**
 * Persist one claimed processing batch to PostgreSQL.
 *
 * The processing key is intentionally NOT deleted until PostgreSQL
 * confirms that the share row was updated successfully.
 */
async function persistProcessingBatch(
  redis: RedisClient,
  processingKey: string,
  shareId: string,
): Promise<PersistResult> {
  const countStr = await redis.get(processingKey);

  /**
   * The processing key may already have been removed after a previous
   * successful attempt.
   */
  if (countStr === null) {
    return {
      status: "success",
      count: 0,
    };
  }

  const count = parseClickCount(countStr, processingKey);

  if (count <= 0) {
    await redis.del(processingKey);

    return {
      status: "success",
      count: 0,
    };
  }

  /**
   * Increment PostgreSQL atomically:
   *
   *   clicks = clicks + count
   *
   * We do not first SELECT the current click count.
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
   * A missing share row is a TERMINAL condition.
   *
   * Retrying this forever would never succeed and would prevent
   * processing from progressing.
   */
  if (result.length === 0) {
    return {
      status: "missing-share",
      count,
      shareId,
    };
  }

  /**
   * PostgreSQL successfully persisted the batch.
   *
   * Now the Redis processing key can be removed.
   */
  await redis.del(processingKey);

  console.log(`✅ Flushed ${count} clicks for share ${shareId}`);

  return {
    status: "success",
    count,
  };
}

// ─────────────────────────────────────────────
// ♻️ RECOVER PROCESSING BATCHES
// ─────────────────────────────────────────────

type FlushPhaseResult = {
  processed: number;
  failed: number;
  terminal: number;
  errors: Error[];
};

/**
 * Recover batches left behind by previous executions.
 *
 * IMPORTANT:
 *
 * This function DOES NOT throw immediately when one batch fails.
 *
 * It processes every page and every key, records failures, and returns
 * the aggregated result.
 *
 * This means one bad batch cannot prevent other batches from being
 * processed.
 */
async function recoverProcessingBatches(
  redis: RedisClient,
): Promise<FlushPhaseResult> {
  let processed = 0;
  let failed = 0;
  let terminal = 0;

  const errors: Error[] = [];

  const iterator = redis.scanIterator({
    MATCH: PROCESSING_KEY_PATTERN,
    COUNT: SCAN_COUNT,
  });

  /**
   * IMPORTANT:
   *
   * redis@6 scanIterator() yields pages:
   *
   *   string[]
   *
   * NOT:
   *
   *   string
   *
   * Therefore we iterate through the page and then through each key.
   */
  for await (const page of iterator as AsyncIterable<string[]>) {
    for (const key of page) {
      const info = getProcessingKeyInfo(key);

      if (!info) {
        const error = new Error(`Invalid processing Redis key format: ${key}`);

        console.warn(`⚠️ ${error.message}`);

        failed += 1;
        errors.push(error);

        continue;
      }

      try {
        const result = await persistProcessingBatch(redis, key, info.shareId);

        if (result.status === "missing-share") {
          /**
           * This is permanently invalid.
           *
           * Quarantine the key so it cannot block every future
           * flush invocation.
           */
          try {
            await quarantineProcessingKey(
              redis,
              key,
              `Share app "${info.shareId}" no longer exists in PostgreSQL.`,
            );

            terminal += 1;

            console.error(
              `🚨 Share "${info.shareId}" does not exist. ` +
                `Quarantined ${result.count} unpersisted clicks.`,
            );
          } catch (quarantineError) {
            /**
             * If quarantine failed, this is a genuine failure.
             * The original processing key remains intact.
             */
            failed += 1;

            const error =
              quarantineError instanceof Error
                ? quarantineError
                : new Error(String(quarantineError));

            errors.push(error);
          }

          continue;
        }

        processed += 1;
      } catch (err) {
        failed += 1;

        const error = err instanceof Error ? err : new Error(String(err));

        errors.push(error);

        console.error(`❌ Failed to recover processing key "${key}"`, err);

        /**
         * IMPORTANT:
         *
         * Do NOT delete the processing key here.
         *
         * A transient PostgreSQL/Redis error should leave the batch
         * available for the next Inngest retry.
         */
      }
    }
  }

  return {
    processed,
    failed,
    terminal,
    errors,
  };
}

// ─────────────────────────────────────────────
// 🔄 FLUSH NEW PENDING COUNTERS
// ─────────────────────────────────────────────

/**
 * Claim and persist newly accumulated share counters.
 *
 * Like recovery, this processes all available pages/keys even when
 * individual keys fail.
 */
async function flushPendingCounters(
  redis: RedisClient,
): Promise<FlushPhaseResult> {
  let processed = 0;
  let failed = 0;
  let terminal = 0;

  const errors: Error[] = [];

  const iterator = redis.scanIterator({
    MATCH: PENDING_KEY_PATTERN,
    COUNT: SCAN_COUNT,
  });

  /**
   * redis@6 scanIterator() yields string[] pages.
   */
  for await (const page of iterator as AsyncIterable<string[]>) {
    for (const key of page) {
      const shareId = getShareIdFromPendingKey(key);

      if (!shareId) {
        const error = new Error(`Invalid pending Redis key format: ${key}`);

        console.warn(`⚠️ ${error.message}`);

        failed += 1;
        errors.push(error);

        continue;
      }

      try {
        const claimed = await claimPendingKey(redis, key);

        /**
         * The key may have disappeared between SCAN and RENAME.
         *
         * Another process may have already claimed it, so there is
         * nothing for this iteration to do.
         */
        if (!claimed) {
          continue;
        }

        const result = await persistProcessingBatch(
          redis,
          claimed.processingKey,
          claimed.shareId,
        );

        if (result.status === "missing-share") {
          /**
           * Terminal condition.
           *
           * Quarantine rather than preserving forever.
           */
          try {
            await quarantineProcessingKey(
              redis,
              claimed.processingKey,
              `Share app "${claimed.shareId}" no longer exists in PostgreSQL.`,
            );

            terminal += 1;

            console.error(
              `🚨 Share "${claimed.shareId}" does not exist. ` +
                `Quarantined ${result.count} unpersisted clicks.`,
            );
          } catch (quarantineError) {
            failed += 1;

            const error =
              quarantineError instanceof Error
                ? quarantineError
                : new Error(String(quarantineError));

            errors.push(error);
          }

          continue;
        }

        processed += 1;
      } catch (err) {
        failed += 1;

        const error = err instanceof Error ? err : new Error(String(err));

        errors.push(error);

        console.error(`❌ Failed to flush pending Redis key "${key}"`, err);

        /**
         * If the key has already been renamed to a processing key,
         * it remains there for the next invocation.
         *
         * This is intentional.
         */
      }
    }
  }

  return {
    processed,
    failed,
    terminal,
    errors,
  };
}

// ─────────────────────────────────────────────
// 🧾 ERROR AGGREGATION
// ─────────────────────────────────────────────

function createAggregatedFlushError(errors: Error[]): Error {
  const message = errors
    .map((error, index) => {
      return `[${index + 1}] ${error.message}`;
    })
    .join("\n");

  return new Error(
    `Share-click flush completed with ${errors.length} error(s):\n${message}`,
  );
}

// ─────────────────────────────────────────────
// 🔁 MAIN FLUSH FUNCTION
// ─────────────────────────────────────────────

export async function flushShares(): Promise<void> {
  console.log("🧠 Starting share-click flush...");

  const redis = await getRedisSafe();

  /**
   * Redis being unavailable is a real failure.
   *
   * We throw rather than return successfully so Inngest sees the
   * failure and can retry.
   *
   * No counters have been claimed at this point.
   */
  if (!redis) {
    throw new Error(
      "Redis is unavailable. Share-click flush was not performed.",
    );
  }

  // ───────────────────────────────────────────
  // 🔒 ACQUIRE DISTRIBUTED LOCK
  // ───────────────────────────────────────────

  const lockToken = await acquireLock(redis);

  if (!lockToken) {
    /**
     * Another flush is already running.
     *
     * No data is lost because that invocation owns the lock and will
     * process the counters.
     */
    console.warn("⚠️ Another flushShares job is already running. Skipping.");

    return;
  }

  try {
    const allErrors: Error[] = [];

    // ─────────────────────────────────────────
    // ♻️ RECOVER OLD PROCESSING BATCHES
    // ─────────────────────────────────────────

    let recoveredResult: FlushPhaseResult;

    try {
      recoveredResult = await recoverProcessingBatches(redis);
    } catch (err) {
      /**
       * SCAN itself can fail, for example if Redis becomes unavailable.
       *
       * Record the failure but DO NOT stop the entire flush yet.
       */
      const error = err instanceof Error ? err : new Error(String(err));

      recoveredResult = {
        processed: 0,
        failed: 1,
        terminal: 0,
        errors: [error],
      };
    }

    allErrors.push(...recoveredResult.errors);

    console.log(
      `♻️ Recovery phase complete. ` +
        `Processed: ${recoveredResult.processed}, ` +
        `Failed: ${recoveredResult.failed}, ` +
        `Quarantined: ${recoveredResult.terminal}`,
    );

    // ─────────────────────────────────────────
    // 🔄 FLUSH NEW PENDING COUNTERS
    // ─────────────────────────────────────────

    let pendingResult: FlushPhaseResult;

    try {
      pendingResult = await flushPendingCounters(redis);
    } catch (err) {
      /**
       * IMPORTANT:
       *
       * Pending processing still runs even if recovery encountered
       * failures.
       *
       * This directly fixes the CodeRabbit issue where:
       *
       * recoverProcessingBatches()
       *       ↓
       * throw
       *       ↓
       * flushPendingCounters() NEVER RUNS
       */
      const error = err instanceof Error ? err : new Error(String(err));

      pendingResult = {
        processed: 0,
        failed: 1,
        terminal: 0,
        errors: [error],
      };
    }

    allErrors.push(...pendingResult.errors);

    console.log(
      `🔄 Pending phase complete. ` +
        `Processed: ${pendingResult.processed}, ` +
        `Failed: ${pendingResult.failed}, ` +
        `Quarantined: ${pendingResult.terminal}`,
    );

    // ─────────────────────────────────────────
    // 📊 FINAL RESULT
    // ─────────────────────────────────────────

    const totalProcessed = recoveredResult.processed + pendingResult.processed;

    const totalFailed = recoveredResult.failed + pendingResult.failed;

    const totalTerminal = recoveredResult.terminal + pendingResult.terminal;

    console.log(
      `🎉 Share-click flush finished. ` +
        `Processed: ${totalProcessed}, ` +
        `Failed: ${totalFailed}, ` +
        `Quarantined: ${totalTerminal}`,
    );

    /**
     * IMPORTANT:
     *
     * Throw AFTER BOTH phases have completed.
     *
     * This allows Inngest to retry transient failures while still
     * allowing healthy counters to be persisted during this invocation.
     */
    if (allErrors.length > 0) {
      throw createAggregatedFlushError(allErrors);
    }
  } catch (err) {
    /**
     * CRITICAL:
     *
     * Never swallow the error here.
     *
     * flushShares() must reject so the surrounding Inngest function
     * can recognize the invocation as failed and perform its configured
     * retries.
     */
    console.error("❌ Share-click flush failed:", err);

    throw err;
  } finally {
    // ─────────────────────────────────────────
    // 🔓 RELEASE DISTRIBUTED LOCK
    // ─────────────────────────────────────────

    await releaseLock(redis, lockToken);
  }
}
