import "dotenv/config";
import { createClient, type RedisClientType } from "redis";
import { getEnv } from "../lib/env";

const env = getEnv();

// ─────────────────────────────────────────────────────────────
// Singleton Redis Client (Production Safe)
// ─────────────────────────────────────────────────────────────

let redis: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType> | null = null;

function createRedisClient(): RedisClientType {
  const client = createClient({
    url: env.REDIS_URL,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          console.error("[redis] Max reconnect attempts reached — giving up");
          return new Error("Redis reconnect limit exceeded");
        }

        // Exponential backoff (capped)
        return Math.min(2 ** retries * 100, 3000);
      },
    },
  });

  // ── Event listeners ─────────────────────────────

  client.on("connect", () => {
    console.log("[redis] Connected");
  });

  client.on("ready", () => {
    console.log("[redis] Ready");
  });

  client.on("reconnecting", () => {
    console.warn("[redis] Reconnecting...");
  });

  client.on("error", (err: Error) => {
    console.error("[redis] Error:", err.message);
  });

  client.on("end", () => {
    console.warn("[redis] Connection closed");
  });

  return client;
}

// ─────────────────────────────────────────────────────────────
// Get Redis (Race-condition safe)
// ─────────────────────────────────────────────────────────────

export async function getRedis(): Promise<RedisClientType> {
  if (!redis) {
    redis = createRedisClient();
  }

  // Already connected
  if (redis.isOpen) {
    return redis;
  }

  // Prevent multiple simultaneous connections
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        await redis!.connect();

        // Health check
        await redis!.ping();
        console.log("[redis] Ping successful");

        return redis!;
      } catch (err) {
        console.error("[redis] Failed to connect:", err);

        // Reset so future retries can happen
        connectPromise = null;

        throw err;
      }
    })();
  }

  return connectPromise;
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown (Production Critical)
// ─────────────────────────────────────────────────────────────

async function shutdown() {
  if (redis && redis.isOpen) {
    try {
      console.log("[redis] Closing connection...");
      await redis.quit();
      console.log("[redis] Connection closed cleanly");
    } catch (err) {
      console.error("[redis] Error during shutdown:", err);
    }
  }
}

// Avoid duplicate listeners (important in dev/serverless)
if (!process.listenerCount("SIGINT")) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
