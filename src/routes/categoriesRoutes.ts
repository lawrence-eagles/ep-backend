import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { categoryVersionOne } from "../controllers/categoriesController";
import { categoryFeedVersionOne } from "../controllers/feeds/categoriesFeedController";

const router = Router();

router.use(authUser);

router.get("/", categoryVersionOne);
router.get("/:categoryId", categoryFeedVersionOne);

export default router;
