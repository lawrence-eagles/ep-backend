import { db } from "../db";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { deviceTokens } from "../db/schema";

export async function registerDeviceToken(req: Request, res: Response) {
  try {
    // =========================
    // 1. VALIDATION
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const userId = req.user.id;
    const { token, platform } = req.body;

    if (!userId || !token || !platform) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🔍 Check if token already exists
    const existing = await db.query.deviceTokens.findFirst({
      where: eq(deviceTokens.token, token),
    });

    if (existing) {
      // 🔁 Token already exists → update ownership + lastSeen
      await db
        .update(deviceTokens)
        .set({
          userId, // reassign if needed
          platform,
          lastSeenAt: new Date(),
        })
        .where(eq(deviceTokens.token, token));

      return res.json({ success: true, updated: true });
    }

    // 🆕 Insert new token
    await db.insert(deviceTokens).values({
      userId,
      token,
      platform,
    });

    return res.json({ success: true, created: true });
  } catch (err) {
    console.error("REGISTER TOKEN ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
