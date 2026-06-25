import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { shareVersionOne } from "../controllers/sharesController";

const router = Router();

router.post("/", authUser, shareVersionOne);

export default router;
