import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth";

import {
  submitReportController,
  getMyReportsController,
} from "../controllers/moderation/reportingController";

const router = Router();

router.use(requireAuth);

router.post("/", submitReportController);

router.get("/mine", getMyReportsController);

export default router;
