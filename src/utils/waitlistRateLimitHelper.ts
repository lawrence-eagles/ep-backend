import type { Request } from "express";
import { isIP } from "node:net";

export function getClientIp(req: Request): string {
  const realIp = req.get("x-real-ip")?.trim();

  // Railway overwrites X-Real-IP on requests through its public HTTP edge.
  // Accept only a valid, single IP address.
  if (realIp && isIP(realIp) !== 0) {
    return realIp;
  }

  // Safe fallback, but this will usually be Railway's proxy address.
  // Requests without a valid X-Real-IP may therefore share a rate-limit bucket.
  const socketIp = req.socket.remoteAddress;

  if (socketIp && isIP(socketIp) !== 0) {
    return socketIp;
  }

  return "unknown";
}
