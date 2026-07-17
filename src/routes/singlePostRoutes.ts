import { Router } from "express";
import { authUser } from "../middleware/authUser";
import { singlePostControllerVersionOne } from "../controllers/singlePostController";

const router = Router();

router.post("/", authUser, singlePostControllerVersionOne);

export default router;
