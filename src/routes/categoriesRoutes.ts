import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { categoryVersionOne } from "../controllers/categoriesController";
import { categoryFeedVersionOne } from "../controllers/feeds/categoriesFeedController";

const router = Router();

router.use(requireAuth);

router.get("/", categoryVersionOne);
router.get("/:categoryId", categoryFeedVersionOne);

export default router;
