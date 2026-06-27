import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { forYouFeedVerisonOne } from "../controllers/feedsController";
import { followsHeadlineVersionOne } from "../controllers/followsHeadlinesController";
import { trendingFeedVersionOne } from "../controllers/trendingsController";
import { singlePostControllerVersionOne } from "../controllers/singlePostController";

const router = Router();
router.use(authUser);

router.get("/", forYouFeedVerisonOne);
router.get("/headlines", followsHeadlineVersionOne);
router.get("/trending", trendingFeedVersionOne);
router.get("/:slug", singlePostControllerVersionOne);

export default router;
