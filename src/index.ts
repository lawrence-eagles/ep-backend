import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { toNodeHandler } from "better-auth/node";
import { inngestHandler } from "./inngest/route";
import { getEnv } from "./lib/env";
import { auth } from "./lib/auth";
import bookmarksRoutes from "./routes/bookmarksRoutes";
import categoriesRoutes from "./routes/categoriesRoutes";
import followsRoutes from "./routes/followsRoutes";
import likesRoutes from "./routes/likesRoutes";
import sharesRoutes from "./routes/sharesRoutes";
import feedsRoutes from "./routes/feedsRoutes";
import commentsRoutes from "./routes/commentsRoutes";
import appShareRoutes from "./routes/appRoutes";
import redirectRoutes from "./routes/redirectRoutes";
import afterAuthCallback from "./routes/auth-callback";
import flushCron from "./routes/flushCron";

const env = getEnv();
const frontendOrigin = new URL(env.FRONTEND_URL).origin;
const app = express();

app.use(
  cors({
    origin: frontendOrigin, // Replace with your frontend's origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], // Specify allowed HTTP methods
    credentials: true, // Allow credentials (cookies, authorization headers, etc.)
  }),
);

// REQUIRED for better auth integration must be before express.json().
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());
app.use(cookieParser());

// 👇 REQUIRED endpoint for Inngest
app.use("/api/inngest", inngestHandler);

app.use("/", redirectRoutes); // handles redirect when user wants to share app
app.use("/api/cron", flushCron);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/app", appShareRoutes);
// call this route after better auth login or registration succeeds. Also must pass cookie
app.use("/api/v1/after-auth", afterAuthCallback);
app.use("/api/v1/posts", feedsRoutes);
app.use("/api/v1/bookmarks", bookmarksRoutes);
app.use("/api/v1/categories", categoriesRoutes);
app.use("/api/v1/follows", followsRoutes);
app.use("/api/v1/likes", likesRoutes);
app.use("/api/v1/shares", sharesRoutes);
app.use("/api/v1/comments", commentsRoutes);

app.listen(env.PORT, () =>
  console.log("Eaglespress sever started and listening on port", env.PORT),
);
