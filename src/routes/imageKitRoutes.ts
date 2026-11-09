import express from "express";
import { generateSignature } from "../controllers/imageKitController";
import { requireAuth } from "../middleware/requireAuth";
const router = express.Router();

router.get("/", requireAuth, generateSignature);

export default router;
