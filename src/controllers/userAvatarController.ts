import type { Request, Response, NextFunction } from "express";
import { updateUserAvatar } from "../services/userAvatar.service";
import { updateAvatarSchema } from "../validators/user.validator";
import { z } from "zod";

function getUserId(req: Request): string | null {
  return req.user?.id ?? null;
}

export async function updateUserAvatarController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getUserId(req);

    if (!userId) {
      res.status(401).json({
        error: "Unauthorized user",
      });
      return;
    }

    /*
     * Validate the request body with Zod.
     */
    const parsed = updateAvatarSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        issues: z.treeifyError(parsed.error),
      });
      return;
    }

    /*
     * Perform the server-side ImageKit ownership
     * validation and transactional database update.
     */
    const updatedUser = await updateUserAvatar(userId, parsed.data);

    res.status(200).json({
      user: updatedUser,
    });
  } catch (error) {
    next(error);
  }
}
