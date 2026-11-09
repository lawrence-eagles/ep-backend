import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { likeCommentVersionOne } from "../controllers/comments/commentsLikesController";
import { unlikeCommentVersionOne } from "../controllers/comments/commentsUnlikesController";

const router = Router();
router.use(requireAuth);

router.post("/", likeCommentVersionOne);
router.delete("/:commentId", unlikeCommentVersionOne);

export default router;
