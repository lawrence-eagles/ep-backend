import { InngestFunction } from "inngest";
import { and, asc, eq } from "drizzle-orm";
import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { deletionLedger, deletionOutbox } from "../../db/schema";

const DELETION_RELAY_BATCH_SIZE = 100;

export const relayPendingUserDeletions: InngestFunction.Any =
  inngest.createFunction(
    {
      id: "relay-pending-user-deletions",
      retries: 3,
      triggers: {
        cron: "* * * * *", // consider running twice daily, or every 6 hours, depending on how many deletions we expect to process
      },
    },

    async ({ step }) => {
      /**
       * Find confirmed deletions that have not yet been successfully
       * externalized to R2.
       *
       * The outbox remains "pending" until the actual R2 worker
       * successfully completes.
       */
      const pendingDeletions = await step.run(
        "find-pending-user-deletions",
        async () => {
          return db
            .select({
              deletionId: deletionLedger.deletionId,
              userId: deletionLedger.userId,
              deletedAt: deletionLedger.deletedAt,
            })
            .from(deletionOutbox)
            .innerJoin(
              deletionLedger,
              eq(deletionOutbox.deletionId, deletionLedger.deletionId),
            )
            .where(
              and(
                eq(deletionOutbox.status, "pending"),
                eq(deletionLedger.status, "confirmed"),
              ),
            )
            .orderBy(asc(deletionLedger.confirmedAt))
            .limit(DELETION_RELAY_BATCH_SIZE);
        },
      );

      if (pendingDeletions.length === 0) {
        return {
          success: true,
          dispatched: 0,
        };
      }

      /**
       * Dispatch every pending deletion to Inngest.
       *
       * IMPORTANT:
       *
       * We deliberately do NOT mark the outbox rows as processed here.
       *
       * The outbox is only marked "processed" by
       * externalizeUserDeletion after the deletion record has
       * successfully been written to R2.
       */
      const dispatched = await step.run(
        "dispatch-pending-user-deletions",
        async () => {
          let count = 0;

          for (const deletion of pendingDeletions) {
            if (!deletion.deletedAt) {
              throw new Error(
                `Confirmed deletion is missing deletedAt. ` +
                  `DeletionId=${deletion.deletionId}, ` +
                  `UserId=${deletion.userId}`,
              );
            }

            await inngest.send({
              name: "user.deletion.externalize",
              data: {
                deletionId: deletion.deletionId,
                userId: deletion.userId,
                deletedAt: deletion.deletedAt,
              },
            });

            count += 1;
          }

          return count;
        },
      );

      return {
        success: true,
        dispatched,
      };
    },
  );
