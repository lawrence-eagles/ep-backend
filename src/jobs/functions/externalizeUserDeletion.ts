import { z } from "zod";
import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { writeDeletionToObjectStorage } from "../../services/deletionLedger/deletion/writeDeletionToObjectStorage";
import { markDeletionOutboxProcessed } from "../../services/deletionLedger/deletion/markDeletionOutboxProcessed";

const userDeletionExternalizeEventSchema = z.object({
  deletionId: z.string().min(1),
  userId: z.string().min(1),
  deletedAt: z.iso.datetime().transform((value) => new Date(value)),
});

export const externalizeUserDeletion: InngestFunction.Any =
  inngest.createFunction(
    {
      id: "externalize-user-deletion",

      /**
       * Deletion records are critical recovery data.
       *
       * We want Inngest to retry transient R2/network/database failures.
       */
      retries: 10,

      triggers: {
        event: "user.deletion.externalize",
      },
    },

    async ({ event, step }) => {
      /**
       * Validate the event at runtime.
       *
       * Inngest event data ultimately comes from an external event
       * delivery mechanism, so don't blindly trust its shape.
       */
      const data = userDeletionExternalizeEventSchema.parse(event.data);

      /**
       * Step 1:
       *
       * Persist the confirmed deletion in independent external storage.
       *
       * This step must complete before the PostgreSQL outbox record is
       * marked as processed.
       */
      const r2Result = await step.run(
        "write-deletion-record-to-r2",
        async () => {
          return writeDeletionToObjectStorage({
            deletionId: data.deletionId,
            userId: data.userId,
            deletedAt: data.deletedAt,
          });
        },
      );

      /**
       * Step 2:
       *
       * Only after R2 has successfully stored and verified the deletion
       * record do we mark the PostgreSQL outbox item as processed.
       */
      await step.run("mark-deletion-outbox-complete", async () => {
        await markDeletionOutboxProcessed(data.deletionId);
      });

      return {
        success: true,
        deletionId: data.deletionId,
        r2Key: r2Result.key,
        r2ObjectCreated: r2Result.created,
      };
    },
  );
