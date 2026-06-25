import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response, NextFunction } from "express";
import { auth } from "../lib/auth"; // Your Better Auth instance

export async function authUser(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // GET BETTER AUTH SESSION NOTE SEND credentials: true from frontend
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  // SESSION VALIDATION
  if (!session) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  req.user = session.user; // attach manually
  next();
}
