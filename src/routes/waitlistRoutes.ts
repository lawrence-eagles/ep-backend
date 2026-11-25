import { Router } from "express";
import {
  subscribe,
  resendVerification,
  verify,
  unsubscribe,
  statusCheck,
  adminListSubscribers,
  adminWaitlistStats,
  adminExportSubscribers,
} from "../controllers/waitlistController";
import { requireAuth } from "../middleware/requireAuth";
import { requireModerator } from "../middleware/requireModerator";
import { waitlistRateLimit } from "../middleware/waitlistRateLimit";

const router = Router();

// Public endpoints
router.post(
  "/subscribe",
  waitlistRateLimit("subscribe", 5, 15 * 60),
  subscribe,
);

router.post(
  "/resend-verification",
  waitlistRateLimit("resend", 5, 15 * 60),
  resendVerification,
);

// The email verification link opens this GET endpoint.
// It verifies the token and redirects to the frontend result page.
router.get("/verify", waitlistRateLimit("verify", 20, 15 * 60), verify);

// Do not make unsubscribe a GET operation.
// Email security scanners can automatically open GET links.
router.post(
  "/unsubscribe",
  waitlistRateLimit("unsubscribe", 10, 15 * 60),
  unsubscribe,
);

router.post("/status", waitlistRateLimit("status", 10, 15 * 60), statusCheck);

// Admin endpoints
router.get(
  "/admin/subscribers",
  requireAuth,
  requireModerator,
  adminListSubscribers,
);

router.get("/admin/stats", requireAuth, requireModerator, adminWaitlistStats);

router.get(
  "/admin/export",
  requireAuth,
  requireModerator,
  adminExportSubscribers,
);

export default router;
