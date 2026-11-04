import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { toNodeHandler } from "better-auth/node";

import { pool } from "./db";
import { inngestHandler } from "./inngest/route";
import { getEnv } from "./lib/env";
import { auth } from "./lib/auth";
import { closeRedis } from "./lib/redis";

import bookmarksRoutes from "./routes/bookmarksRoutes";
import categoriesRoutes from "./routes/categoriesRoutes";
import followsRoutes from "./routes/followsRoutes";
import likesRoutes from "./routes/likesRoutes";
import commentLikesRoutes from "./routes/commentLikesRoutes";
import sharesRoutes from "./routes/sharesRoutes";
import feedsRoutes from "./routes/feedsRoutes";
import commentsRoutes from "./routes/commentsRoutes";
import appShareRoutes from "./routes/appRoutes";
import redirectRoutes from "./routes/redirectRoutes";
import afterAuthCallback from "./routes/auth-callback";
import registerDeviceTokenRoute from "./routes/deviceTokenRoutes";
import singlePostRoutes from "./routes/singlePostRoutes";
import imageKitRoutes from "./routes/imageKitRoutes";
import userAvatarRouter from "./routes/userAvatarRoutes";
import userBlockRoutes from "./routes/userBlock";

const env = getEnv();
const frontendOrigin = new URL(env.FRONTEND_URL).origin;

const app = express();

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────

app.use(
  cors({
    origin: frontendOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  }),
);

// ─────────────────────────────────────────────
// PROXY AND COOKIES
// ─────────────────────────────────────────────

app.set("trust proxy", true);

app.use(cookieParser());

// ─────────────────────────────────────────────
// BETTER AUTH
// Must be registered before the global JSON parser.
// ─────────────────────────────────────────────

app.all("/api/auth/*splat", toNodeHandler(auth));

// ─────────────────────────────────────────────
// INNGEST
// Give Inngest its own JSON body limit.
// This must remain before the global JSON parser.
// ─────────────────────────────────────────────

app.use("/api/inngest", express.json({ limit: "10mb" }));

app.use("/api/inngest", inngestHandler);

// ─────────────────────────────────────────────
// GLOBAL JSON PARSER
// Used by the normal application routes.
// ─────────────────────────────────────────────

app.use(express.json());

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// APPLICATION ROUTES
// ─────────────────────────────────────────────

app.use("/auth", imageKitRoutes);
app.use("/api/user", userAvatarRouter);
app.use("/app", appShareRoutes);
app.use("/api/v1/users", userBlockRoutes);
app.use("/api/v1/push", registerDeviceTokenRoute);
app.use("/api/v1/after-auth", afterAuthCallback);
app.use("/api/v1/posts", feedsRoutes);
app.use("/api/v1/bookmarks", bookmarksRoutes);
app.use("/api/v1/categories", categoriesRoutes);
app.use("/api/v1/follows", followsRoutes);
app.use("/api/v1/likes", likesRoutes);
app.use("/api/v1/comment-likes", commentLikesRoutes);
app.use("/api/v1/shares", sharesRoutes);
app.use("/api/v1/comments", commentsRoutes);
app.use("/api/v1/single-post/:slug", singlePostRoutes);

app.use("/s/:id", redirectRoutes);

// ─────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log("Eaglespress server started and listening on port", env.PORT);
});

// ─────────────────────────────────────────────
// POSTGRESQL POOL MONITORING
// ─────────────────────────────────────────────

function logPoolMetrics() {
  console.info("PostgreSQL pool metrics:", {
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingRequests: pool.waitingCount,
  });
}

// Log pool metrics every 60 seconds.
const poolMetricsInterval = setInterval(() => {
  logPoolMetrics();
}, 60_000);

// Allow Node.js to exit naturally without this interval keeping it alive.
poolMetricsInterval.unref();

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string) {
  // If another shutdown signal arrives while cleanup is running,
  // force termination instead of ignoring the signal indefinitely.
  if (isShuttingDown) {
    console.error(
      `${signal} received while shutdown is already in progress. Forcing exit.`,
    );

    process.exit(1);
  }

  isShuttingDown = true;

  console.log(`${signal} received. Shutting down gracefully...`);

  clearInterval(poolMetricsInterval);

  // Force-close remaining HTTP connections after 15 seconds.
  const forceCloseTimer = setTimeout(() => {
    console.warn(
      "Shutdown timeout reached. Closing remaining HTTP connections.",
    );

    server.closeAllConnections();
  }, 15_000);

  forceCloseTimer.unref();

  // Hard deadline for the complete shutdown process.
  // This covers HTTP, Redis, and PostgreSQL cleanup.
  const hardExitTimer = setTimeout(() => {
    console.error("Graceful shutdown exceeded 25s. Forcing exit.");

    process.exit(1);
  }, 25_000);

  // Do not let this timer alone keep Node.js alive.
  // It can still fire if other active handles keep the event loop running.
  hardExitTimer.unref();

  try {
    // 1. Stop accepting new requests and wait for active requests.
    // Redis remains available to in-flight requests during this drain.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    clearTimeout(forceCloseTimer);

    // 2. Close Redis.
    // closeRedis() prevents new Redis connections and reconnection attempts
    // before cleaning up the existing connection.
    await closeRedis();

    // 3. Close PostgreSQL.
    await pool.end();

    console.log("All connections closed successfully.");

    process.exitCode = 0;
  } catch (error) {
    clearTimeout(forceCloseTimer);

    console.error("Error during graceful shutdown:", error);

    // Force-close remaining HTTP connections.
    server.closeAllConnections();

    // Best-effort cleanup.
    // The hard-exit timer remains active if either operation hangs.
    await Promise.allSettled([closeRedis(), pool.end()]);

    process.exitCode = 1;
  }

  // new addition
  // Cancel the hard deadline only after all cleanup has completed.
  // If cleanup hangs, execution never reaches this line,
  // allowing the timer to force termination after 25 seconds.
  clearTimeout(hardExitTimer);
}

// ─────────────────────────────────────────────
// PROCESS SIGNAL HANDLERS
// ─────────────────────────────────────────────

// Railway normally sends SIGTERM during deployments and restarts.
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// Useful for local development and manual termination.
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
