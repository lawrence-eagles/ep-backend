import { Router } from "express";
import { shareAppsRedirectControllerVersionOne } from "../controllers/shareAppsRedirectController";

const router = Router();

router.get("/", shareAppsRedirectControllerVersionOne);

export default router;
