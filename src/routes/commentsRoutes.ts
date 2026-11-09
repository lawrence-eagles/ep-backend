import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { createCommentVersionOne } from "../controllers/comments/createCommentsController";
import { deleteCommentVersionOne } from "../controllers/comments/deleteCommentsController";
import { updateCommentVersionOne } from "../controllers/comments/updateCommentsController";
import { fetchCommentsVersionOne } from "../controllers/comments/fetchCommentsController";

const router = Router();

router.use(requireAuth);

router.get("/:postId", fetchCommentsVersionOne);
router.post("/:postId", createCommentVersionOne);
router.put("/:id", updateCommentVersionOne);
router.delete("/:id", deleteCommentVersionOne);

export default router;
