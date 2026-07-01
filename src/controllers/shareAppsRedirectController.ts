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
    // ✅ 1. Validate shareId EARLY (no Redis yet)
    const shareId = req.params.id;
    if (!shareId || typeof shareId !== "string") {
      return res.redirect("https://eaglespress.com/notfound");
    }

    // ✅ 2. Normalize UA
    const userAgent = normalizeUserAgent(req.headers["user-agent"]);

    // 🔥 3. BOT / FRAUD FILTER (cheap checks first)
    if (req.ip === "known-bot")
      return res.redirect("https://eaglespress.com/notfound");
    if (isBot(userAgent))
      return res.redirect("https://eaglespress.com/notfound");

    // ✅ 4. Resolve IP safely
    const ip = req.ip || "0.0.0.0";
    const ipHash = hashIP(ip);

    // ─────────────────────────────────────────
    // 🔥 REDIS (LAZY + OPTIONAL)
    // ─────────────────────────────────────────
    const redis = await getRedisSafe();

    let shouldCountClick = true;

    if (redis) {
      try {
        const dedupeKey = `click:${shareId}:${ipHash}`;

        const exists = await redis.get(dedupeKey);

        if (!exists) {
          await redis.set(dedupeKey, "1", { EX: 600 });
          await redis.incr(`share:${shareId}:clicks`);
        } else {
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
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // ─────────────────────────────────────────
    // 🔁 FINAL REDIRECT
    // ─────────────────────────────────────────
    return res.redirect("https://eaglespress.com/downloads");
  } catch (error) {
    console.error("Redirect controller error:", error);

    // 🔥 NEVER FAIL USER FLOW
    return res.redirect("https://eaglespress.com/downloads");
  }
};
