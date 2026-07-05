import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { shareAppsControllerVersionOne } from "../controllers/shareAppsController";

const router = Router();

router.post("/", authUser, shareAppsControllerVersionOne);

export default router;
