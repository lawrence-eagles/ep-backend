import { db } from "../db";
import { shareClicks } from "../db/schema";
import type { Request, Response } from "express";
import { getRedis } from "../lib/redis";
import { hashIP, isBot } from "../utils/security";
import { getEnv } from "../lib/env";

const env = getEnv();

// ─────────────────────────────────────────────
// 🔒 SAFE REDIS INITIALIZER (FAIL-SAFE)
// ─────────────────────────────────────────────
async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// 🧠 USER AGENT NORMALIZER
// ─────────────────────────────────────────────
function normalizeUserAgent(
  ua: string | string[] | undefined,
): string | undefined {
  if (!ua) return undefined;
  if (typeof ua === "string") return ua;
  if (Array.isArray(ua)) return ua.join(" ");
  return undefined;
}

// ─────────────────────────────────────────────
// 🚀 CONTROLLER (PRODUCTION HARDENED)
// ─────────────────────────────────────────────
export const shareAppsRedirectControllerVersionOne = async (
  req: Request,
  res: Response,
) => {
  try {
    // ✅ 1. Validate shareId EARLY
    const shareId = req.params.id;
    if (!shareId || typeof shareId !== "string") {
      return res.redirect(`${env.FRONTEND_URL}/notfound`);
    }

    // ✅ 2. Normalize UA
    const userAgent = normalizeUserAgent(req.headers["user-agent"]);

    // 🔥 3. BOT / FRAUD FILTER
    if (req.ip === "known-bot") {
      return res.redirect(`${env.FRONTEND_URL}/notfound`);
    }

    if (isBot(userAgent)) {
      return res.redirect(`${env.FRONTEND_URL}/notfound`);
    }

    // ✅ 4. Resolve IP
    const ip = req.ip || "0.0.0.0";
    const ipHash = hashIP(ip);

    // ─────────────────────────────────────────
    // 🔥 REDIS (ATOMIC DEDUPE)
    // ─────────────────────────────────────────
    const redis = await getRedisSafe();

    let shouldCountClick = true;

    if (redis) {
      try {
        const dedupeKey = `click:${shareId}:${ipHash}`;

        /**
         * 🔥 ATOMIC OPERATION
         * SET NX ensures only one request wins
         */
        const result = await redis.set(dedupeKey, "1", {
          NX: true,
          EX: 600, // 10 min dedupe window
        });

        if (result === "OK") {
          // ✅ Only first request increments
          await redis.incr(`share:${shareId}:clicks`);
        } else {
          // ❌ Duplicate request
          shouldCountClick = false;
        }
      } catch (err) {
        console.error("REDIS OPERATION ERROR:", err);
        // fallback → still allow DB write
      }
    }

    // ─────────────────────────────────────────
    // 🗄️ DATABASE (ASYNC, NON-BLOCKING)
    // ─────────────────────────────────────────
    if (shouldCountClick) {
      db.insert(shareClicks)
        .values({
          shareId,
          ipHash,
          userAgent: userAgent ?? null,
        })
        .catch((err) => {
          console.error("Share click insert failed:", err);
        });
    }

    // ─────────────────────────────────────────
    // 🍪 ATTRIBUTION COOKIE
    // ─────────────────────────────────────────
    res.cookie("sid", shareId, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    ``;

    // ─────────────────────────────────────────
    // 🔁 FINAL REDIRECT
    // ─────────────────────────────────────────
    return res.redirect(`${env.FRONTEND_URL}/downloads`);
  } catch (error) {
    console.error("Redirect controller error:", error);

    // 🔥 FAIL SAFE
    return res.redirect(`${env.FRONTEND_URL}/downloads`);
  }
};
