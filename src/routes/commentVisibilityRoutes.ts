import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  hideCommentController,
  unhideCommentController,
} from "../controllers/moderation/hideCommentsController";

const router = Router();

router.use(requireAuth);

router.post("/:commentId/hide", hideCommentController);

router.delete("/:commentId/hide", unhideCommentController);

export default router;
