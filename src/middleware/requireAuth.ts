import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth";

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user?.id) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    req.user = session.user;

    return next();
  } catch (error) {
    console.error("AUTH_MIDDLEWARE_ERROR:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
