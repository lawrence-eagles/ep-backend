import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { shareAppsControllerVersionOne } from "../controllers/shareAppsController";

const router = Router();

router.post("/", requireAuth, shareAppsControllerVersionOne);

export default router;
