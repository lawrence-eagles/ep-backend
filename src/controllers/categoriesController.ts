import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db";

export const categoryVersionOne = async (req: Request, res: Response) => {
  // =========================
  // 1. VALIDATION
  // =========================
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized user" });
  }

  // GET USER ID FROM req.user COMING FROM MIDDLEWARE
  const userId = req.user.id;

  try {
    // =========================
    // 2. QUERY (LEFT JOIN)
    // =========================
    const result = await db.execute(sql`
      SELECT 
        c.id,
        c.name,
        c.slug,
        c.created_at,
        CASE 
          WHEN f.user_id IS NOT NULL THEN true 
          ELSE false 
        END AS "isFollowing"
      FROM categories c
      LEFT JOIN follows f
        ON f.category_id = c.id
        AND f.user_id = ${userId}
      ORDER BY c.name ASC
    `);

    // =========================
    // 3. RESPONSE
    // =========================
    return res.json({
      success: true,
      categories: result.rows,
    });
  } catch (err) {
    console.error("GET CATEGORIES ERROR:", err);
    return res.status(500).json({
      error: "Failed to fetch categories",
    });
  }
};
