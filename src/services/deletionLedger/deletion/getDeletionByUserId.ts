import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { deletionLedger } from "../../../db/schema";

export interface DeletionRecord {
  deletionId: string;
  userId: string;
  deletedAt: Date;
}

export async function getDeletionByUserId(
  userId: string,
): Promise<DeletionRecord | null> {
  if (!userId || userId.trim().length === 0) {
    throw new Error(
      "Cannot retrieve deletion ledger record: userId is required.",
    );
  }

  const [deletion] = await db
    .select({
      deletionId: deletionLedger.deletionId,
      userId: deletionLedger.userId,
      deletedAt: deletionLedger.deletedAt,
    })
    .from(deletionLedger)
    .where(eq(deletionLedger.userId, userId))
    .limit(1);

  return deletion ?? null;
}
