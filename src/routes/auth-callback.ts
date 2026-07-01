import { Router } from "express";
import type { Request, Response } from "express";
import { authUser } from "../middleware/authUser";
import { trackConversion } from "../services/trackConversion";

const router = Router();

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

    const user = req.user;

    // =========================
    // 2. GET SHARE ID FROM COOKIE
    // =========================
    const shareId = req.cookies?.sid as string | undefined;

    if (!shareId) {
      return res.json({ success: true });
    }

    // =========================
    // 3. DETERMINE CONVERSION TYPE
    // =========================
    /**
     * You should ideally have this from your auth system.
     * Fallback logic included.
     */
    const isNewUser =
      (user as any).isNewUser === true || // preferred (set during signup)
      ((user as any).createdAt &&
        Date.now() - new Date((user as any).createdAt).getTime() < 60_000);

    const type: "signup" | "open" = isNewUser ? "signup" : "open";

    // =========================
    // 4. TRACK CONVERSION (SAFE)
    // =========================
    try {
      await trackConversion(shareId, user.id, type);
    } catch (err: any) {
      /**
       * Ignore duplicate errors (unique constraint)
       * but log everything else
       */
      if (
        !err?.message?.includes("duplicate") &&
        !err?.code?.includes("23505") // Postgres unique violation
      ) {
        console.error("Conversion tracking failed:", err);
      }
    }

    // =========================
    // 5. CLEAR COOKIE (CRITICAL FIX)
    // =========================
    res.clearCookie("sid", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    // =========================
    // 6. RESPONSE
    // =========================
    return res.json({
      success: true,
      tracked: true,
      type,
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

// NOTE CALL THIS ROUTE AFTER LOGIN OR REGISTRATION SUCCEEDES. NOTE MUST PASS COOKIE AS SEEN BELOW:
// await fetch("/api/after-auth", {
//   method: "POST",
//   credentials: "include", // 🔥 REQUIRED for cookies
// });
