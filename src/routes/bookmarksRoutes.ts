import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  bookmarkVersionOne,
  unbookmarkVersionOne,
} from "../controllers/bookmarksController";
import { bookmarksFeedVersionOne } from "../controllers/feeds/bookmarksFeedController";

const router = Router();

router.use(requireAuth);

router.get("/", bookmarksFeedVersionOne);
router.post("/", bookmarkVersionOne);
router.delete("/:postId", unbookmarkVersionOne);

export default router;
