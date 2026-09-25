import type { InngestFunction } from "inngest";
import { and, asc, eq, gt } from "drizzle-orm";

import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { deletionLedger, deletionOutbox } from "../../db/schema";

const DELETION_RELAY_BATCH_SIZE = 100;

type PendingDeletion = {
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
       * Keyset pagination cursor.
       *
       * deletionId is unique, so it provides a stable cursor
       * without relying on timestamp precision.
       */
      let cursor: string | null = null;

      while (true) {
        const currentCursor = cursor;

        const pendingDeletions: PendingDeletion[] = await step.run(
          `find-pending-user-deletions-${batchNumber}`,
          async (): Promise<PendingDeletion[]> => {
            const conditions = [eq(deletionOutbox.status, "pending")];

            /**
             * Move past rows already dispatched during this
             * relay execution.
             *
             * The outbox remains pending until the externalizer
             * finishes, so status alone cannot be used for
             * pagination.
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
         * No more pending outbox records after the current
         * cursor.
         */
        if (pendingDeletions.length === 0) {
          break;
        }

        /**
         * The database schema guarantees deletedAt is NOT NULL,
         * so no runtime nullable validation is required here.
         *
         * Keeping the explicit type also prevents TypeScript from
         * widening the event payload unexpectedly.
         */
        const events = pendingDeletions.map((deletion: PendingDeletion) => ({
          name: "user.deletion.externalize" as const,

          /**
           * Deterministic event ID.
           *
           * This makes the same deletion event stable across:
           *
           * - relay retries
           * - Inngest function replays
           * - repeated scheduled relay runs
           */
          id: `user-deletion-externalize-${deletion.deletionId}`,

          data: {
            deletionId: deletion.deletionId,
            userId: deletion.userId,
            deletedAt: deletion.deletedAt,
          },
        }));

        const dispatched = await step.run(
          `dispatch-pending-user-deletions-${batchNumber}`,
          async (): Promise<number> => {
            /**
             * Send the entire batch in one Inngest request.
             */
            await inngest.send(events);

            return events.length;
          },
        );

        totalDispatched += dispatched;

        /**
         * Advance the keyset cursor only after the entire batch
         * has been successfully handed to Inngest.
         */
        cursor = pendingDeletions[pendingDeletions.length - 1].deletionId;

        batchNumber += 1;

        /**
         * A short final batch means there are no more rows
         * after the current cursor.
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
