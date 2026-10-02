import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";

import { auth } from "../lib/auth";
import { updateUserAvatar } from "../services/userAvatar.service";
import { updateAvatarSchema } from "../validators/user.validator";

export async function updateUserAvatarController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    /*
     * Resolve the Better Auth session from the
     * incoming request headers.
     */
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      res.status(401).json({
        error: "Unauthorized",
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
        issues: parsed.error.flatten(),
      });
      return;
    }

    /*
     * Perform the server-side ImageKit ownership
     * validation and transactional database update.
     */
    const updatedUser = await updateUserAvatar(session.user.id, parsed.data);

    res.status(200).json({
      user: updatedUser,
    });
  } catch (error) {
    next(error);
  }
}
