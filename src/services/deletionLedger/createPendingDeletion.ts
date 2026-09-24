import { db } from "../../db";
import { deletionLedger, deletionOutbox } from "../../db/schema";

export async function createPendingDeletion(userId: string) {
  return db.transaction(async (tx) => {
    const [ledger] = await tx
      .insert(deletionLedger)
      .values({
        userId,
        status: "pending",
      })
      .onConflictDoNothing({
        target: deletionLedger.userId,
      })
      .returning();

    if (!ledger) {
      return;
    }

    await tx.insert(deletionOutbox).values({
      deletionId: ledger.deletionId,
      userId,
      status: "pending",
    });

    return ledger;
  });
}
