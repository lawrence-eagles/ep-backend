import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { registerDeviceToken } from "../controllers/deviceTokenController";

const router = Router();

router.post("/register", authUser, registerDeviceToken);

export default router;
