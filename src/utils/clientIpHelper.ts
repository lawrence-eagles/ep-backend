import type { Request } from "express";
import { isIP } from "node:net";

export function getClientIp(req: Request): string {
  const realIp = req.get("x-real-ip")?.trim();

  if (realIp && isIP(realIp) !== 0) {
    return realIp;
  }

  const socketIp = req.socket.remoteAddress;

  if (socketIp && isIP(socketIp) !== 0) {
    return socketIp;
  }

  return "unknown";
}
