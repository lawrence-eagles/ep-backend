import express from "express";
import { generateSignature } from "../controllers/imageKitController";
import { authUser } from "../middleware/authUser";
const router = express.Router();

router.get("/", authUser, generateSignature);

export default router;
