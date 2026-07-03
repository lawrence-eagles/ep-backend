import { Router } from "express";
import { shareAppsRedirectControllerVersionOne } from "../controllers/shareAppsRedirectController";

const router = Router({ mergeParams: true });

router.get("/", shareAppsRedirectControllerVersionOne);

export default router;
