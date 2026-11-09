import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";

import { updateUserAvatarController } from "../controllers/userAvatarController";

const router = Router();

router.patch("/avatar", requireAuth, updateUserAvatarController);

export default router;
