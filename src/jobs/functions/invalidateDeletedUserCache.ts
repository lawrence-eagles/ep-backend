import { z } from "zod";
import type { InngestFunction } from "inngest";
import { inngest } from "../../lib/inngest";
import { invalidateUserCaches } from "../../services/deletionLedger/deletion/invalidateUserCaches";

const userDeletionExternalizeEventSchema = z.object({
  deletionId: z.string().min(1),
  userId: z.string().min(1),
  deletedAt: z.coerce.date(),
});

export const invalidateDeletedUserCache: InngestFunction.Any =
  inngest.createFunction(
    {
      id: "invalidate-deleted-user-cache",
      retries: 10,
      triggers: {
        event: "user.deletion.externalize",
      },
    },
    async ({ event, step }) => {
      const data = userDeletionExternalizeEventSchema.parse(event.data);

      const result = await step.run(
        "invalidate-deleted-user-cache",
        async () => {
          return invalidateUserCaches(data.userId);
        },
      );

      return {
        success: true,
        userId: data.userId,
        scannedKeys: result.scannedKeys,
        deletedKeys: result.deletedKeys,
      };
    },
  );
