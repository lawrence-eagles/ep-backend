import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin, requireModerator } from "../middleware/moderatorAuth";
import {
  getModerationReportsController,
  getModerationReportController,
  updateModerationReportController,
  getModeratorsController,
  grantModeratorController,
  revokeModeratorController,
} from "../controllers/moderation/moderationController";
import { deleteModeratedCommentController } from "../controllers/moderation/softDeleteCommentController";
import { banUserController } from "../controllers/moderation/banUserController";
import { unbanUserController } from "../controllers/moderation/unbanUserController";
import { fetchBannedUsersController } from "../controllers/moderation/fetchBanUsersController";

const router = Router();

// All moderation endpoints require an authenticated moderator.
router.use(requireAuth);
router.use(requireModerator);

// Report management.
router.get("/reports", getModerationReportsController);

router.get("/reports/:reportId", getModerationReportController);

router.patch("/reports/:reportId", updateModerationReportController);

// Only bootstrap administrators can manage moderator roles.
router.get("/roles", requireAdmin, getModeratorsController);

router.post("/roles", requireAdmin, grantModeratorController);

router.delete("/roles/:userId", requireAdmin, revokeModeratorController);

router.delete("/comments/:commentId", deleteModeratedCommentController);

router.post("/users/:userId/ban", banUserController);

router.post("/users/:userId/unban", unbanUserController);

router.get("/banned-users", fetchBannedUsersController);

export default router;
