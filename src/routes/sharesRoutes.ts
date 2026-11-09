import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { shareVersionOne } from "../controllers/sharesController";

const router = Router();

router.post("/", requireAuth, shareVersionOne);

export default router;
