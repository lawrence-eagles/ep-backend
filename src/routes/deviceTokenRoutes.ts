import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { registerDeviceToken } from "../controllers/deviceTokenController";

const router = Router();

router.post("/register", requireAuth, registerDeviceToken);

export default router;
