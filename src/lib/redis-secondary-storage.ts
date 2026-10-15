import type { SecondaryStorage } from "better-auth";
import { getRedis } from "../lib/redis";

// Use the same prefix across every application instance
// that shares Better Auth secondary storage.
const KEY_PREFIX = "better-auth:";

function getKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/**
 * Better Auth 1.7.9 secondary storage backed by node-redis.
 *
 * Implements all five required methods:
 * - get
 * - set
 * - delete
 * - getAndDelete
 * - increment
 */
const storage: SecondaryStorage = {
  /**
   * Retrieve a value from Redis.
   * Redis returns null when the key does not exist.
   */
  async get(key: string): Promise<unknown> {
    const client = await getRedis();

    return client.get(getKey(key));
  },

  /**
   * Store a value, optionally with a TTL in seconds.
   *
   * A missing or non-positive TTL means no expiration,
   * matching Better Auth's standard storage contract.
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    const client = await getRedis();
    const redisKey = getKey(key);

    if (ttl !== undefined && ttl > 0) {
      await client.set(redisKey, value, { EX: ttl });
      return;
    }

    await client.set(redisKey, value);
  },

  /**
   * Delete a value from Redis.
   */
  async delete(key: string): Promise<void> {
    const client = await getRedis();

    await client.del(getKey(key));
  },

  /**
   * Atomically retrieve and delete a value.
   * Requires Redis server version 6.2 or newer.
   */
  async getAndDelete(key: string): Promise<string | null> {
    const client = await getRedis();

    return client.getDel(getKey(key));
  },

  /**
   * Atomically increment a counter and set its expiry
   * only when the key is first created.
   *
   * The increment and expiry are executed in one Redis
   * transaction, preventing concurrent requests from
   * losing increments.
   */
  async increment(key: string, ttl: number): Promise<number> {
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new TypeError("Redis increment TTL must be a positive integer");
    }

    const client = await getRedis();
    const redisKey = getKey(key);

    const [value] = await client
      .multi()
      .incr(redisKey)
      .expire(redisKey, ttl, "NX")
      .execTyped();

    return value;
  },
};

export const redisSecondaryStorage = storage;
