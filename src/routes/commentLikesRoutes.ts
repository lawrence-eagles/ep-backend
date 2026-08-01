import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { likeCommentVersionOne } from "../controllers/comments/commentsLikesController";
import { unlikeCommentVersionOne } from "../controllers/comments/commentsUnlikesController";

const router = Router();
router.use(authUser);

router.post("/", likeCommentVersionOne);
router.delete("/:commentId", unlikeCommentVersionOne);

export default router;
