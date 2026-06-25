import { Router } from "express";
import { authUser } from "../middleware/authUser";
import {
  followVersionOne,
  unfollowVersionOne,
} from "../controllers/followsController";

const router = Router();

router.use(authUser);

router.post("/", followVersionOne);
router.delete("/:categoryId", unfollowVersionOne);

export default router;
