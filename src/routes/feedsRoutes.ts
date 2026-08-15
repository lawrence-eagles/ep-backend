import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { forYouFeedVerisonOne } from "../controllers/feeds/feedsController";
import { followingVersionOne } from "../controllers/feeds/followingController";
import { trendingFeedVersionOne } from "../controllers/feeds/trendingsController";

const router = Router();
router.use(authUser);

router.get("/", forYouFeedVerisonOne);
router.get("/following", followingVersionOne);
router.get("/trending", trendingFeedVersionOne);

export default router;
