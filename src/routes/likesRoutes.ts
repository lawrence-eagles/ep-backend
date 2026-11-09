import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  likeVersionOne,
  unlikeVersionOne,
} from "../controllers/likesController";

const router = Router();
router.use(requireAuth);

router.post("/", likeVersionOne);
router.delete("/:postId", unlikeVersionOne);

export default router;
