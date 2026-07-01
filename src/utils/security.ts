import crypto from "crypto";

export function hashIP(ip: string) {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

export function isBot(userAgent?: string) {
  if (!userAgent) return false;
  return /bot|crawl|spider|slurp/i.test(userAgent);
}
