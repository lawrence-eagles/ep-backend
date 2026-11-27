import type { Request, Response, NextFunction } from "express";
import { createHmac } from "node:crypto";
import { getRedis } from "../lib/redis";
import { getEnv } from "../lib/env";
import { getClientIp } from "../utils/waitlistRateLimitHelper";

const env = getEnv();

/**
 * Atomically increments a rate-limit counter and ensures it has a TTL.
 *
 * - New keys receive the configured expiry.
 * - Existing keys with a valid TTL keep their original expiry.
 * - Existing keys without a TTL have their expiry repaired.
 *
 * Redis executes the entire script atomically.
 */
const INCREMENT_WITH_TTL_SCRIPT = `
  local count = redis.call("INCR", KEYS[1])
  local ttl = redis.call("TTL", KEYS[1])

  if ttl == -1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end

  return count
`;

export function waitlistRateLimit(
  scope: string,
  limit: number,
  windowSeconds: number,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const redis = await getRedis();

      const ip = getClientIp(req);

      const ipHash = createHmac("sha256", env.IP_HASH_SECRET)
        .update(ip)
        .digest("hex");

      const key = `rate-limit:waitlist:${scope}:${ipHash}`;

      // Increment the counter and set or repair its TTL atomically.
      const count = Number(
        await redis.eval(INCREMENT_WITH_TTL_SCRIPT, {
          keys: [key],
          arguments: [String(windowSeconds)],
        }),
      );

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
