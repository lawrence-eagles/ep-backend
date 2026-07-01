import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { flushShares } from "../workers/flushShares";
import { authUser } from "../middleware/authUser"; // Better Auth middleware
import { getEnv } from "../lib/env";

const env = getEnv();

const router = Router();

/**
 * 🔐 CRON AUTH GUARD
 * Supports:
 * 1. Machine (Railway cron via secret)
 * 2. Human (authenticated admin via Better Auth)
 */
async function cronAuthGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers["x-cron-secret"];

    // ✅ Normalize header (string | string[] | undefined → string | undefined)
    const normalizedToken =
      typeof token === "string"
        ? token
        : Array.isArray(token) && token.length > 0
          ? token[0]
          : undefined;

    // ✅ 1. Allow machine access (Railway cron)
    if (
      normalizedToken &&
      env.CRON_SECRET &&
      normalizedToken === env.CRON_SECRET
    ) {
      return next();
    }

    // ✅ 2. Fallback to Better Auth (admin user)
    return authUser(req, res, next);
  } catch (err) {
    console.error("Cron auth error:", err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/**
 * 🔥 Flush Shares Endpoint
 */
router.get("/flush", cronAuthGuard, async (req: Request, res: Response) => {
  try {
    await flushShares();

    return res.json({
      success: true,
      message: "Shares flushed successfully",
    });
  } catch (error) {
    console.error("Flush error:", error);

    return res.status(500).json({
      success: false,
      error: "Flush failed",
    });
  }
});

export default router;
