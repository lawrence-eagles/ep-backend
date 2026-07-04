import { Router } from "express";
import { shareAppsRedirectControllerVersionOne } from "../controllers/shareAppsRedirectController";

// Always check new express version to followup on this api because without this the params would not be passed.
const router = Router({ mergeParams: true });

router.get("/", shareAppsRedirectControllerVersionOne);

export default router;
