import type { Request, Response, NextFunction } from "express";
import {
  blockUser,
  unblockUser,
  getBlockedUsers,
  getBlockStatus,
  UserBlockError,
} from "../services/userBlock";
import { userBlockParamsSchema } from "../validators/userBlock";

/**
 * Block user.
 */
export async function blockUserController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  try {
    const parsed = userBlockParamsSchema.safeParse(req.params);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      });
    }

    const result = await blockUser(req.user.id, parsed.data.userId);

    return res.status(200).json({
      success: true,
      message: "User blocked successfully.",
      data: result,
    });
  } catch (error) {
    if (error instanceof UserBlockError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    next(error);
  }
}

/**
 * Unblock user.
 */
export async function unblockUserController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  try {
    const parsed = userBlockParamsSchema.safeParse(req.params);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      });
    }

    const result = await unblockUser(req.user.id, parsed.data.userId);

    return res.status(200).json({
      success: true,
      message: result.wasBlocked
        ? "User unblocked successfully."
        : "User was not blocked.",
      data: result,
    });
  } catch (error) {
    if (error instanceof UserBlockError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    next(error);
  }
}

/**
 * Get blocked users.
 */
export async function getBlockedUsersController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  try {
    const result = await getBlockedUsers(req.user.id);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Check block status.
 */
export async function getBlockStatusController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  try {
    const parsed = userBlockParamsSchema.safeParse(req.params);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      });
    }

    const result = await getBlockStatus(req.user.id, parsed.data.userId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
