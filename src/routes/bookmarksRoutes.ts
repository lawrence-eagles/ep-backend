import { Router } from "express";
import { authUser } from "../middleware/authUser";
import {
  bookmarkVersionOne,
  unbookmarkVersionOne,
} from "../controllers/bookmarksController";

const router = Router();

router.use(authUser);

router.post("/", bookmarkVersionOne);
router.delete("/:postId", unbookmarkVersionOne);

export default router;
