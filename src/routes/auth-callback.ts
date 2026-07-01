import { Router } from "express";
import type { Request, Response } from "express";
import { authUser } from "../middleware/authUser";
import { trackConversion } from "../services/trackConversion";

const router = Router();

router.post("/", authUser, async (req: Request, res: Response) => {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }
  const user = req.user;

  const shareId = req.cookies.sid;

  if (shareId) {
    await trackConversion(shareId, user.id, "signup");
  }

  res.json({ success: true });
});

export default router;

// NOTE CALL THIS ROUTE AFTER LOGIN OR REGISTRATION SUCCEEDES. NOTE MUST PASS COOKIE AS SEEN BELOW:
// await fetch("/api/after-auth", {
//   method: "POST",
//   credentials: "include", // 🔥 REQUIRED for cookies
// });
