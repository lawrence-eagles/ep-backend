import { db } from "../db";
import { shareApps } from "../db/schema";
import type { Request, Response } from "express";
import { getEnv } from "../lib/env";

const env = getEnv();

export const shareAppsControllerVersionOne = async (
  req: Request,
  res: Response,
) => {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  const user = req.user;

  const { postId, channel } = req.body;

  if (!postId || !channel) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const [share] = await db
    .insert(shareApps)
    .values({
      userId: user.id,
      postId,
      channel,
    })
    .returning();

  return res.json({
    url: `${env.BACKEND_URL}/s/${share.id}`,
    shareId: share.id,
  });
};
