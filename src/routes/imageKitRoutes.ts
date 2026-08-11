import express from "express";
import { generateSignature } from "../controllers/imageKitController";
const router = express.Router();

router.get("/", generateSignature);

export default router;
