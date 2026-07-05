import { db } from "../db";
import { shareApps } from "../db/schema";
import type { Request, Response } from "express";
import { getEnv } from "../lib/env";
import { z } from "zod";

const env = getEnv();

/**
 * =========================
 * 🔒 VALIDATION SCHEMA
 * =========================
 */

// Strict UUID validation
const uuidSchema = z.uuid();

/**
 * 🔥 Allowed share channels
 * Lock this down to protect analytics integrity
 */
const allowedChannels = [
  "twitter",
  "facebook",
  "whatsapp",
  "instagram",
  "tiktok",
  "linkedin",
  "email",
  "copy_link",
] as const;

const shareSchema = z.object({
  postId: uuidSchema,
  channel: z.enum(allowedChannels),
});

/**
 * =========================
 * 🚀 CONTROLLER
 * =========================
 */
export const shareAppsControllerVersionOne = async (
  req: Request,
  res: Response,
) => {
  try {
    // =========================
    // 1. AUTH CHECK
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const user = req.user as { id: string };

    // =========================
    // 2. VALIDATE INPUT
    // =========================
    const parsed = shareSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request payload",
        details: z.flattenError(parsed.error), // ✅ FIXED (no deprecation)
      });
    }

    const { postId, channel } = parsed.data;

    // =========================
    // 3. INSERT (SAFE)
    // =========================
    const [share] = await db
      .insert(shareApps)
      .values({
        userId: user.id,
        postId,
        channel,
      })
      .returning();

    if (!share) {
      // Extremely rare but safe guard
      return res.status(500).json({
        error: "Failed to create share link",
      });
    }

    // =========================
    // 4. RESPONSE
    // =========================
    return res.status(201).json({
      url: `${env.BACKEND_URL}/s/${share.id}`,
      shareId: share.id,
    });
  } catch (err) {
    // =========================
    // 5. ERROR HANDLING
    // =========================
    console.error("SHARE_APPS_ERROR:", err);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
