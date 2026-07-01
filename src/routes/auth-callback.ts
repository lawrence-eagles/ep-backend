import { Router } from "express";
import type { Request, Response } from "express";
import { authUser } from "../middleware/authUser";
import { trackConversion } from "../services/trackConversion";

const router = Router();

/**
 * 🔒 SAFE TRACKING WRAPPER
 * Guarantees boolean success/failure
 */
async function trackConversionSafe(
  shareId: string,
  userId: string,
  type: "signup" | "open",
): Promise<boolean> {
  try {
    await trackConversion(shareId, userId, type);

    // ✅ If no error thrown → success
    return true;
  } catch (err: any) {
    /**
     * ✅ Treat duplicates as success (idempotent)
     */
    if (
      err?.code === "23505" || // Postgres unique violation
      err?.message?.toLowerCase().includes("duplicate")
    ) {
      return true;
    }

    console.error("Conversion tracking failed:", err);
    return false;
  }
}

/**
 * 🔥 AUTH CALLBACK
 * Handles:
 * - Signup conversion
 * - Returning user open
 * - Prevents duplicate tracking
 */
router.post("/", authUser, async (req: Request, res: Response) => {
  try {
    // =========================
    // 1. AUTH VALIDATION
    // =========================
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized user" });
    }

    const user = req.user as {
      id: string;
      isNewUser?: boolean;
    };

    // =========================
    // 2. GET SHARE ID FROM COOKIE
    // =========================
    const shareId = req.cookies?.sid as string | undefined;

    if (!shareId) {
      return res.json({ success: true, tracked: false });
    }

    // =========================
    // 3. DETERMINE CONVERSION TYPE
    // =========================
    /**
     * ✅ ONLY trust explicit auth signal
     */
    const type: "signup" | "open" = user.isNewUser === true ? "signup" : "open";

    // =========================
    // 4. TRACK CONVERSION
    // =========================
    const tracked = await trackConversionSafe(shareId, user.id, type);

    // =========================
    // 5. CLEAR COOKIE ONLY IF SUCCESS
    // =========================
    if (tracked) {
      res.clearCookie("sid", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    }

    // =========================
    // 6. RESPONSE
    // =========================
    return res.json({
      success: true,
      tracked,
      type: tracked ? type : undefined,
    });
  } catch (error) {
    console.error("Auth callback error:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

export default router;

/**
 * =========================
 * 📌 CLIENT USAGE
 * =========================
 *
 * await fetch("/api/after-auth", {
 *   method: "POST",
 *   credentials: "include", // 🔥 REQUIRED
 * });
 */
