import { Router } from "express";
import { shareAppsRedirectControllerVersionOne } from "../controllers/shareAppsRedirectController";

const router = Router();

router.get("/s/:id", shareAppsRedirectControllerVersionOne);

export default router;
