import { Router } from "express";

import {
  blockUserController,
  unblockUserController,
  getBlockedUsersController,
  getBlockStatusController,
} from "../controllers/userBlock";

import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// All endpoints require authentication.
router.use(requireAuth);

// Block a user.
router.post("/:userId/block", blockUserController);

// Unblock a user.
router.delete("/:userId/block", unblockUserController);

// Get authenticated user's blocked users.
router.get("/blocked", getBlockedUsersController);

// Check whether authenticated user blocked another user.
router.get("/:userId/block-status", getBlockStatusController);

export default router;
