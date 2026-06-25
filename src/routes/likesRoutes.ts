import { Router } from "express";
import { authUser } from "../middleware/authUser";
import {
  likeVersionOne,
  unlikeVersionOne,
} from "../controllers/likesController";

const router = Router();
router.use(authUser);

router.post("/", likeVersionOne);
router.delete("/:postId", unlikeVersionOne);

export default router;
