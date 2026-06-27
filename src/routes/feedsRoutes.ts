import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { forYouFeedVerisonOne } from "../controllers/feeds/feedsController";
import { followsHeadlineVersionOne } from "../controllers/feeds/followsHeadlinesController";
import { trendingFeedVersionOne } from "../controllers/feeds/trendingsController";
import { singlePostControllerVersionOne } from "../controllers/singlePostController";

const router = Router();
router.use(authUser);

router.get("/", forYouFeedVerisonOne);
router.get("/headlines", followsHeadlineVersionOne);
router.get("/trending", trendingFeedVersionOne);
router.get("/:slug", singlePostControllerVersionOne);

export default router;
