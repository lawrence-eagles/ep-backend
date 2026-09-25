import { InngestFunction } from "inngest";
import { and, asc, eq, gt } from "drizzle-orm";

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
       * The cursor is the deletionId of the last row dispatched
       * during this relay execution.
       *
       * deletionId is unique, so it provides a stable keyset
       * pagination cursor without relying on timestamp precision.
       *
       * It starts at null because the first query should begin
       * from the first pending deletion.
       */
      let cursor: string | null = null;

      /**
       * Continue processing batches until there are no more
       * confirmed deletions after the current cursor.
       *
       * Keyset pagination is important here because the dispatched
       * outbox rows remain "pending" until the separate
       * externalizeUserDeletion function successfully completes.
       *
       * Therefore, we must not rely on the outbox status changing
       * between batches.
       */
      while (true) {
        const currentCursor = cursor;

        const pendingDeletions: PendingDeletion[] = await step.run(
          `find-pending-user-deletions-${batchNumber}`,
          async (): Promise<PendingDeletion[]> => {
            const conditions = [
              eq(deletionOutbox.status, "pending"),
              eq(deletionLedger.status, "confirmed"),
            ];

            /**
             * After the first batch, only select rows whose
             * deletionId is greater than the last dispatched
             * deletionId.
             *
             * This allows the relay to move forward even when
             * previously dispatched rows are still pending.
             */
            if (currentCursor !== null) {
              conditions.push(gt(deletionLedger.deletionId, currentCursor));
            }

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
              .where(and(...conditions))
              .orderBy(asc(deletionLedger.deletionId))
              .limit(DELETION_RELAY_BATCH_SIZE);
          },
        );

        /**
         * No more pending deletions after the current cursor.
         *
         * The relay has reached the end of the current keyset
         * pagination range.
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
         * This prevents duplicate event processing within
         * Inngest's event deduplication window if the relay is
         * replayed or retried.
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

        /**
         * Advance the keyset cursor immediately after the batch
         * has been successfully dispatched.
         *
         * We deliberately do NOT wait for the outbox rows to become
         * "processed". The separate externalizeUserDeletion function
         * is responsible for that.
         *
         * The next database query will therefore move past this
         * batch even if these rows are still "pending".
         */
        cursor = validatedDeletions[validatedDeletions.length - 1].deletionId;

        batchNumber += 1;

        /**
         * If fewer than the maximum batch size were returned,
         * there cannot be another row after this batch within
         * the current query result.
         *
         * We can finish without performing another database query.
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
