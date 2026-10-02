import { Router } from "express";

import { updateUserAvatarController } from "../controllers/userAvatarController";

const router = Router();

router.patch("/avatar", updateUserAvatarController);

export default router;
