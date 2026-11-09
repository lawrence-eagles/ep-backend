import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { forYouFeedVerisonOne } from "../controllers/feeds/feedsController";
import { followingVersionOne } from "../controllers/feeds/followingController";
import { trendingFeedVersionOne } from "../controllers/feeds/trendingsController";

const router = Router();
router.use(requireAuth);

router.get("/", forYouFeedVerisonOne);
router.get("/following", followingVersionOne);
router.get("/trending", trendingFeedVersionOne);

export default router;
