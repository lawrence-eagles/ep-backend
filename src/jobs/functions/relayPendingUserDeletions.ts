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
      let totalDispatched = 0;
      let batchNumber = 0;

      /**
       * Continue processing batches until there are no more
       * confirmed deletions waiting in the outbox.
       *
       * This prevents a maximum throughput of only
       * 100 deletions per cron execution.
       */
      while (true) {
        const pendingDeletions: PendingDeletion[] = await step.run(
          `find-pending-user-deletions-${batchNumber}`,
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

        /**
         * No more pending deletions.
         *
         * The relay has completely drained the outbox.
         */
        if (pendingDeletions.length === 0) {
          break;
        }

        /**
         * Validate every deletion before dispatching the batch.
         *
         * A confirmed deletion must have deletedAt because that
         * timestamp is required by the external deletion ledger
         * stored in R2.
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
         * Dispatch the current batch.
         *
         * Every event has a deterministic ID based on deletionId.
         *
         * This is important because the outbox row remains "pending"
         * until externalizeUserDeletion successfully writes the
         * deletion record to R2 and marks the outbox row as processed.
         *
         * If this relay function is retried, the same deletion can
         * safely be dispatched again because the event ID remains
         * deterministic.
         */
        const dispatched = await step.run(
          `dispatch-pending-user-deletions-${batchNumber}`,
          async () => {
            const events = validatedDeletions.map(
              (deletion: ValidatedPendingDeletion) => ({
                name: "user.deletion.externalize" as const,

                /**
                 * Deterministic event ID.
                 *
                 * deletionId is globally unique, so it provides
                 * a stable identity for this deletion event.
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
             * Send the entire batch in one Inngest request.
             */
            await inngest.send(events);

            return events.length;
          },
        );

        totalDispatched += dispatched;
        batchNumber += 1;

        /**
         * If fewer than the maximum batch size were returned,
         * there cannot be another row after this batch under the
         * current query state.
         *
         * We can finish immediately instead of performing one
         * unnecessary database query.
         */
        if (pendingDeletions.length < DELETION_RELAY_BATCH_SIZE) {
          break;
        }
      }

      return {
        success: true,
        dispatched: totalDispatched,
        batches: batchNumber,
      };
    },
  );
