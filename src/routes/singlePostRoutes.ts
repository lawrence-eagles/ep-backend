import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { singlePostControllerVersionOne } from "../controllers/singlePostController";

const router = Router();

router.post("/", requireAuth, singlePostControllerVersionOne);

export default router;
