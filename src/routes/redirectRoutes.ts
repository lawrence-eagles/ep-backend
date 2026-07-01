import { Router } from "express";
import { shareAppsRedirectControllerVersionOne } from "../controllers/shareAppsRedirectController";

const router = Router();

router.post("/s/:id", shareAppsRedirectControllerVersionOne);

export default router;
