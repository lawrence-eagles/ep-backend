import { eq } from "drizzle-orm";
import { db } from "../../db";
import { deletionLedger } from "../../db/schema";

export async function confirmDeletion(userId: string) {
  const deletedAt = new Date();

  const [deletion] = await db
    .update(deletionLedger)
    .set({
      status: "confirmed",
      confirmedAt: deletedAt,
      deletedAt,
    })
    .where(eq(deletionLedger.userId, userId))
    .returning({
      deletionId: deletionLedger.deletionId,
      userId: deletionLedger.userId,
      deletedAt: deletionLedger.deletedAt,
    });

  if (!deletion) {
    throw new Error(
      `Deletion ledger record not found while confirming user deletion. ` +
        `UserId=${userId}`,
    );
  }

  if (!deletion.deletedAt) {
    throw new Error(
      `Deletion was confirmed but deletedAt is missing. ` +
        `UserId=${userId}, DeletionId=${deletion.deletionId}`,
    );
  }

  return deletion;
}
