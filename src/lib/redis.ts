import "dotenv/config";
import { createClient, type RedisClientType } from "redis";
import { getEnv } from "../lib/env";

const env = getEnv();

// ─────────────────────────────────────────────────────────────
// SINGLETON REDIS CLIENT
// ─────────────────────────────────────────────────────────────

let redis: RedisClientType | null = null;

let connectPromise: Promise<RedisClientType> | null = null;

let closePromise: Promise<void> | null = null;

// Prevents new Redis clients and reconnection attempts during shutdown.
let isShuttingDown = false;

// ─────────────────────────────────────────────────────────────
// SHUTDOWN ERROR
// ─────────────────────────────────────────────────────────────

function createShutdownError(): Error {
  return new Error(
    "[redis] Redis operations are disabled because application shutdown has started.",
  );
}

// ─────────────────────────────────────────────────────────────
// PREVENT REDIS RECONNECTIONS
// ─────────────────────────────────────────────────────────────

export function preventRedisReconnects(): void {
  isShuttingDown = true;
}

// ─────────────────────────────────────────────────────────────
// CREATE REDIS CLIENT
// ─────────────────────────────────────────────────────────────

function createRedisClient(): RedisClientType {
  const client = createClient({
    url: env.REDIS_URL,
    socket: {
      connectTimeout: 5_000,

      reconnectStrategy: (retries) => {
        // Never reconnect once application shutdown begins.
        if (isShuttingDown) {
          return createShutdownError();
        }

        // Preserve the existing maximum retry configuration.
        if (retries > 10) {
          console.error("[redis] Max reconnect attempts reached — giving up");

          return new Error("Redis reconnect limit exceeded");
        }

        // Preserve the existing exponential backoff.
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
// GET REDIS
// ─────────────────────────────────────────────────────────────

export async function getRedis(): Promise<RedisClientType> {
  // Reject all new Redis operations after shutdown begins.
  if (isShuttingDown) {
    throw createShutdownError();
  }

  // Create the singleton client if it does not exist.
  if (!redis) {
    redis = createRedisClient();
  }

  const client = redis;

  // Return the existing ready client.
  if (client.isReady) {
    return client;
  }

  // Reuse an existing connection attempt.
  if (!connectPromise) {
    const attempt = (async (): Promise<RedisClientType> => {
      try {
        if (!client.isOpen) {
          await client.connect();
        }

        // Shutdown may have started while connecting.
        if (isShuttingDown) {
          throw createShutdownError();
        }

        await client.ping();

        // Check again before returning the client.
        if (isShuttingDown) {
          throw createShutdownError();
        }

        console.log("[redis] Ping successful");

        return client;
      } catch (err) {
        // Avoid logging an expected shutdown rejection as a
        // connection failure.
        if (!isShuttingDown) {
          console.error("[redis] Failed to connect:", err);
        }

        throw err;
      }
    })();

    connectPromise = attempt;

    // Clear the connection promise when the attempt settles.
    // Attach both handlers so a rejected attempt does not produce
    // an unhandled rejection from a separate finally() promise.
    void attempt.then(
      () => {
        if (connectPromise === attempt) {
          connectPromise = null;
        }
      },
      () => {
        if (connectPromise === attempt) {
          connectPromise = null;
        }
      },
    );
  }

  // Wait for the shared connection attempt.
  const connectedClient = await connectPromise;

  // Do not return a client if shutdown started while awaiting it.
  if (isShuttingDown) {
    throw createShutdownError();
  }

  return connectedClient;
}

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// Called centrally from index.ts.
// ─────────────────────────────────────────────────────────────

export async function closeRedis(): Promise<void> {
  // Always prevent new clients and reconnections before cleanup.
  preventRedisReconnects();

  // If cleanup is already running, reuse the same operation.
  if (closePromise) {
    return closePromise;
  }

  const client = redis;

  if (!client) {
    return;
  }

  const closing = (async (): Promise<void> => {
    try {
      // Wait for any connection attempt that started before shutdown.
      const pendingConnection = connectPromise;

      if (pendingConnection) {
        try {
          await pendingConnection;
        } catch {
          // Connection failure or shutdown rejection is already handled
          // by getRedis().
        }
      }

      // Close a successfully established connection gracefully.
      if (client.isReady) {
        console.log("[redis] Closing connection...");

        await client.quit();

        console.log("[redis] Connection closed cleanly");
      } else if (client.isOpen) {
        // A client that is open but not ready cannot be relied upon
        // to complete a graceful QUIT operation.
        console.log("[redis] Client is not ready. Destroying connection...");

        client.destroy();
      }
    } catch (err) {
      console.error("[redis] Error during shutdown:", err);

      // Best-effort forced closure if graceful closure fails.
      if (client.isOpen) {
        try {
          client.destroy();
        } catch (destroyError) {
          console.error(
            "[redis] Error while force-closing connection:",
            destroyError,
          );
        }
      }

      // Propagate the original graceful shutdown error.
      throw err;
    } finally {
      // Release references to the closed client.
      if (redis === client) {
        redis = null;
      }

      connectPromise = null;
    }
  })();

  closePromise = closing;

  try {
    await closing;
  } finally {
    if (closePromise === closing) {
      closePromise = null;
    }
  }
}
