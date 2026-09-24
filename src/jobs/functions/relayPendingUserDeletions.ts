import { InngestFunction } from "inngest";
import { and, asc, eq } from "drizzle-orm";

import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { deletionLedger, deletionOutbox } from "../../db/schema";

const DELETION_RELAY_BATCH_SIZE = 100;

type PendingDeletion = {
  deletionId: string;
  userId: string;
  deletedAt: Date | null;
};

type ValidatedPendingDeletion = {
  deletionId: string;
  userId: string;
  deletedAt: Date;
};

export const relayPendingUserDeletions: InngestFunction.Any =
  inngest.createFunction(
    {
      id: "relay-pending-user-deletions",
      retries: 3,
      triggers: {
        /**
         * Runs four times daily at:
         *
         * 00:00 UTC
         * 06:00 UTC
         * 12:00 UTC
         * 18:00 UTC
         */
        cron: "0 0,6,12,18 * * *",
      },
    },

    async ({ step }) => {
      /**
       * Find confirmed deletions that have not yet been successfully
       * externalized to R2.
       *
       * The outbox remains "pending" until externalizeUserDeletion
       * successfully:
       *
       * 1. Writes the deletion record to R2.
       * 2. Marks the outbox row as "processed".
       *
       * Therefore, a failed R2 operation leaves the outbox row
       * available for a later relay run.
       */
      const pendingDeletions: PendingDeletion[] = await step.run(
        "find-pending-user-deletions",
        async (): Promise<PendingDeletion[]> => {
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
       * Validate every pending deletion before dispatching.
       *
       * A confirmed deletion must have deletedAt because that
       * timestamp is required by the external deletion ledger
       * stored in R2.
       *
       * We create a new array containing only validated records.
       * This gives the dispatch code a properly narrowed type:
       *
       * deletedAt: Date
       *
       * rather than:
       *
       * deletedAt: Date | null
       */
      const validatedDeletions: ValidatedPendingDeletion[] =
        pendingDeletions.map(
          (deletion: PendingDeletion): ValidatedPendingDeletion => {
            if (!deletion.deletedAt) {
              throw new Error(
                `Confirmed deletion is missing deletedAt. ` +
                  `DeletionId=${deletion.deletionId}, ` +
                  `UserId=${deletion.userId}`,
              );
            }

            return {
              deletionId: deletion.deletionId,
              userId: deletion.userId,
              deletedAt: deletion.deletedAt,
            };
          },
        );

      /**
       * Dispatch the validated deletions.
       *
       * Each event receives a deterministic ID derived from the
       * deletionId.
       *
       * This is important because the outbox row remains "pending"
       * until externalizeUserDeletion finishes.
       *
       * If the R2 operation is slow or temporarily failing, a later
       * relay execution can encounter the same pending row.
       *
       * Using a deterministic event ID allows Inngest to deduplicate
       * repeated sends of the same deletion event within its
       * deduplication window.
       *
       * The outbox is NOT marked as processed here.
       *
       * externalizeUserDeletion is responsible for marking the
       * outbox row as processed after the R2 write succeeds.
       */
      const dispatched = await step.run(
        "dispatch-pending-user-deletions",
        async () => {
          const events = validatedDeletions.map(
            (deletion: ValidatedPendingDeletion) => ({
              name: "user.deletion.externalize" as const,

              /**
               * Deterministic event ID.
               *
               * deletionId is globally unique, so it is suitable
               * for identifying this specific deletion event.
               */
              id: `user-deletion-externalize-${deletion.deletionId}`,

              data: {
                deletionId: deletion.deletionId,
                userId: deletion.userId,
                deletedAt: deletion.deletedAt,
              },
            }),
          );

          /**
           * Send the entire batch in one Inngest request instead
           * of making up to 100 sequential inngest.send() calls.
           */
          await inngest.send(events);

          return events.length;
        },
      );

      return {
        success: true,
        dispatched,
      };
    },
  );
