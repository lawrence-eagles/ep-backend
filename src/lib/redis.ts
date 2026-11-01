import "dotenv/config";
import { createClient, type RedisClientType } from "redis";
import { getEnv } from "../lib/env";

const env = getEnv();

// ─────────────────────────────────────────────────────────────
// Singleton Redis Client
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

        return Math.min(2 ** retries * 100, 3000);
      },
    },
  });

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
// Get Redis
// ─────────────────────────────────────────────────────────────

export async function getRedis(): Promise<RedisClientType> {
  if (!redis) {
    redis = createRedisClient();
  }

  if (redis.isReady) {
    return redis;
  }

  if (!connectPromise) {
    const client = redis;

    connectPromise = (async () => {
      try {
        if (!client.isOpen) {
          await client.connect();
        }

        await client.ping();

        console.log("[redis] Ping successful");

        return client;
      } catch (err) {
        console.error("[redis] Failed to connect:", err);
        throw err;
      } finally {
        connectPromise = null;
      }
    })();
  }

  return connectPromise;
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown
// Called centrally from index.ts.
// ─────────────────────────────────────────────────────────────

export async function closeRedis(): Promise<void> {
  const client = redis;

  if (!client) {
    return;
  }

  try {
    // Wait for an existing connection attempt to settle.
    if (connectPromise) {
      try {
        await connectPromise;
      } catch {
        // Connection failure is already logged by getRedis().
      }
    }

    // Close the connection if it is still open.
    if (client.isOpen) {
      console.log("[redis] Closing connection...");

      await client.quit();

      console.log("[redis] Connection closed cleanly");
    }
  } catch (err) {
    console.error("[redis] Error during shutdown:", err);

    // Best-effort forced closure if graceful closure fails.
    if (client.isOpen) {
      client.destroy();
    }
  } finally {
    redis = null;
    connectPromise = null;
  }
}
