import crypto from "crypto";
import { getEnv } from "../lib/env";

const env = getEnv();

/**
 * 🔐 Get hashing secret (REQUIRED)
 */
function getHashSecret(): string {
  const secret = env.IP_HASH_SECRET;

  if (!secret) {
    throw new Error("IP_HASH_SECRET is not set");
  }

  return secret;
}

/**
 * 🌐 Normalize IP (handles IPv6 + proxies)
 */
function normalizeIP(ip: string): string {
  if (!ip) return "0.0.0.0";

  // Handle IPv6 localhost / mapped IPv4
  if (ip === "::1") return "127.0.0.1";

  if (ip.startsWith("::ffff:")) {
    return ip.replace("::ffff:", "");
  }

  return ip;
}

/**
 * 🔒 Secure IP hashing (HMAC-SHA256)
 * Prevents brute-force reversal
 */
export function hashIP(ip: string): string {
  const secret = getHashSecret();
  const normalizedIP = normalizeIP(ip);

  return crypto.createHmac("sha256", secret).update(normalizedIP).digest("hex");
}

/**
 * 🤖 Bot detection (production hardened)
 */
export function isBot(userAgent?: string): boolean {
  // Missing/empty UA is highly indicative of automated traffic.
  if (!userAgent) return true;

  const ua = userAgent.toLowerCase();

  /**
   * 🔥 Known bot patterns
   * (carefully scoped to avoid false positives)
   */
  const botPatterns = [
    "bot",
    "crawler",
    "spider",
    "slurp",
    "facebookexternalhit",
    "whatsapp",
    "preview",
    "discordbot",
    "telegrambot",
    "googlebot",
    "bingbot",
    "yandex",
    "duckduckbot",
  ];

  return botPatterns.some((pattern) => ua.includes(pattern));
}
