import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { moderatorRoles } from "../db/schema";

export async function requireModerator(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const moderator = await db.query.moderatorRoles.findFirst({
      where: eq(moderatorRoles.userId, req.user.id),
      columns: { userId: true },
    });

    if (!moderator) {
      return res.status(403).json({ error: "Forbidden." });
    }

    return next();
  } catch (error) {
    console.error("WAITLIST_MODERATOR_CHECK_ERROR:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
}
