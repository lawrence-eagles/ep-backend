import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  followVersionOne,
  unfollowVersionOne,
} from "../controllers/followsController";

const router = Router();

router.use(requireAuth);

router.post("/", followVersionOne);
router.delete("/:categoryId", unfollowVersionOne);

export default router;
