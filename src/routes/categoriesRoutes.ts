import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { categoryVersionOne } from "../controllers/categoriesController";

const router = Router();

router.get("/", authUser, categoryVersionOne);

export default router;
