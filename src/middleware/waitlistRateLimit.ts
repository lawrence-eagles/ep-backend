import type { Request, Response, NextFunction } from "express";
import { createHmac } from "node:crypto";
import { getRedis } from "../lib/redis";
import { getEnv } from "../lib/env";

const env = getEnv();

export function waitlistRateLimit(
  scope: string,
  limit: number,
  windowSeconds: number,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const redis = await getRedis();

      const ip =
        req.headers["cf-connecting-ip"]?.toString() ||
        req.ip ||
        req.socket.remoteAddress ||
        "unknown";

      const ipHash = createHmac("sha256", env.IP_HASH_SECRET)
        .update(ip)
        .digest("hex");

      const key = `rate-limit:waitlist:${scope}:${ipHash}`;

      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (count > limit) {
        res.setHeader("Retry-After", String(windowSeconds));

        return res.status(429).json({
          error: "Too many requests. Please try again later.",
        });
      }

      return next();
    } catch (error) {
      console.error("WAITLIST_RATE_LIMIT_ERROR:", error);

      // Fail closed: do not accept unprotected requests if Redis is down.
      return res.status(503).json({
        error: "Service temporarily unavailable. Please try again shortly.",
      });
    }
  };
}
