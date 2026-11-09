import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { moderatorRoles } from "../db/schema";

function getBootstrapAdminIds(): Set<string> {
  return new Set(
    (process.env.MODERATOR_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isBootstrapAdmin(userId: string): boolean {
  return getBootstrapAdminIds().has(userId);
}

export const requireModerator = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized user",
      });
    }

    // Bootstrap administrators automatically have moderator access.
    if (isBootstrapAdmin(userId)) {
      return next();
    }

    const [role] = await db
      .select({
        userId: moderatorRoles.userId,
      })
      .from(moderatorRoles)
      .where(eq(moderatorRoles.userId, userId))
      .limit(1);

    if (!role) {
      return res.status(403).json({
        error: "Moderator access required",
      });
    }

    return next();
  } catch (error) {
    console.error("MODERATOR_AUTH_ERROR:", error);

    return res.status(500).json({
      error: "Unable to verify moderator permissions",
    });
  }
};

// Only bootstrap administrators can grant or revoke moderator roles.
export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = req.user?.id;

  if (!userId || !isBootstrapAdmin(userId)) {
    return res.status(403).json({
      error: "Administrator access required",
    });
  }

  return next();
};
