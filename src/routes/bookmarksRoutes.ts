import { Router } from "express";
import { authUser } from "../middleware/authUser";
import {
  bookmarkVersionOne,
  unbookmarkVersionOne,
} from "../controllers/bookmarksController";
import { bookmarksFeedVersionOne } from "../controllers/feeds/bookmarksFeedController";

const router = Router();

router.use(authUser);

router.get("/", bookmarksFeedVersionOne);
router.post("/", bookmarkVersionOne);
router.delete("/:postId", unbookmarkVersionOne);

export default router;
