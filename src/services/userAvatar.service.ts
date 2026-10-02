import { eq } from "drizzle-orm";

import { db } from "../db";
import { imagekitCleanup, user } from "../db/schema";
import { imagekit } from "../lib/imageKit";
import type { UpdateAvatarInput } from "../validators/user.validator";

const PROFILE_IMAGE_PATH_PREFIX = "/eaglespress/profile-images/";

export async function updateUserAvatar(
  userId: string,
  input: UpdateAvatarInput,
) {
  /*
   * Verify that the ImageKit file exists.
   *
   * A missing file is treated as invalid input.
   */
  const file = await imagekit.files.get(input.imageFileId).catch(() => null);

  if (!file) {
    throw new Error("Invalid image file");
  }

  /*
   * The file must belong to this authenticated user.
   *
   * We intentionally validate the server-side ImageKit
   * path rather than trusting the imageFileId supplied
   * by the mobile client.
   */
  const expectedPrefix = `${PROFILE_IMAGE_PATH_PREFIX}${userId}/`;

  if (!file.filePath?.startsWith(expectedPrefix)) {
    throw new Error("Invalid image file");
  }

  /*
   * The URL stored in the database must come from the
   * verified ImageKit file.
   *
   * Do not trust input.image because the client could
   * provide a valid ImageKit file ID together with an
   * unrelated URL.
   */
  const verifiedImageUrl = file.url;

  if (typeof verifiedImageUrl !== "string" || verifiedImageUrl.length === 0) {
    throw new Error("Invalid image file");
  }

  /*
   * Update the user and coordinate cleanup cancellation
   * inside the same PostgreSQL transaction.
   */
  const result = await db.transaction(async (tx) => {
    /*
     * Lock the user row before reading imageFileId.
     *
     * This serializes concurrent avatar updates for the
     * same user.
     *
     * Example:
     *
     * Request 1: A -> B
     * Request 2: A -> C
     *
     * Request 2 cannot read A until Request 1 has
     * finished its transaction.
     */
    const [currentUser] = await tx
      .select({
        id: user.id,
        image: user.image,
        imageFileId: user.imageFileId,
      })
      .from(user)
      .where(eq(user.id, userId))
      .for("update")
      .limit(1);

    if (!currentUser) {
      throw new Error("User not found");
    }

    const oldImageFileId = currentUser.imageFileId ?? null;

    const imageFileChanged = oldImageFileId !== input.imageFileId;

    /*
     * If this exact ImageKit file was previously queued
     * for deletion, coordinate with that cleanup job
     * before making the file active again.
     *
     * We lock the cleanup row so its state cannot change
     * concurrently while we make this decision.
     */
    const [existingCleanup] = await tx
      .select({
        id: imagekitCleanup.id,
        status: imagekitCleanup.status,
      })
      .from(imagekitCleanup)
      .where(eq(imagekitCleanup.fileId, input.imageFileId))
      .for("update")
      .limit(1);

    if (existingCleanup) {
      /*
       * A pending job has not been claimed by a worker yet.
       *
       * It is safe to cancel it by deleting the durable
       * cleanup row before reusing the file.
       *
       * If a scanner has already emitted an Inngest event
       * for this row, the eventual worker will find no row
       * and therefore cannot delete the file.
       */
      if (existingCleanup.status === "pending") {
        await tx
          .delete(imagekitCleanup)
          .where(eq(imagekitCleanup.id, existingCleanup.id));
      }

      /*
       * A processing job has already been claimed by a
       * cleanup worker.
       *
       * Do NOT reactivate the file because that worker may
       * already be in the process of deleting it from
       * ImageKit.
       *
       * The safest behavior is to reject this avatar update.
       */
      if (existingCleanup.status === "processing") {
        throw new Error(
          "This image is currently being deleted and cannot be used as an avatar",
        );
      }

      /*
       * A completed cleanup means the file has already
       * been deleted (or was already absent from ImageKit).
       *
       * It cannot safely be reused.
       */
      if (existingCleanup.status === "completed") {
        throw new Error("This image is no longer available");
      }

      /*
       * A failed cleanup is intentionally treated as
       * unavailable as well.
       *
       * The file may still physically exist, but the
       * cleanup system has already determined that the
       * deletion operation failed. Reusing it here would
       * create an ambiguous ownership state.
       */
      if (existingCleanup.status === "failed") {
        throw new Error("This image is unavailable");
      }
    }

    /*
     * If the user is already using this exact file and
     * there was no cleanup job requiring cancellation,
     * there is nothing to clean up.
     *
     * We still perform the normal update below so the
     * stored URL remains synchronized with the verified
     * ImageKit file.
     */
    const [updatedUser] = await tx
      .update(user)
      .set({
        /*
         * IMPORTANT:
         *
         * Use the URL returned by ImageKit for the verified
         * file rather than input.image supplied by the client.
         */
        image: verifiedImageUrl,
        imageFileId: input.imageFileId,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning({
        id: user.id,
        image: user.image,
        imageFileId: user.imageFileId,
      });

    if (!updatedUser) {
      throw new Error("Failed to update user avatar");
    }

    /*
     * Queue the previous ImageKit file for deletion.
     *
     * This happens inside the same transaction as the
     * user update.
     *
     * If the transaction rolls back:
     *
     *   user update rolls back
     *   cleanup row rolls back
     *
     * If the transaction commits:
     *
     *   new avatar is saved
     *   old avatar cleanup is durable
     */
    if (imageFileChanged && oldImageFileId !== null) {
      await tx
        .insert(imagekitCleanup)
        .values({
          fileId: oldImageFileId,
          userId,
          status: "pending",
        })
        .onConflictDoNothing({
          target: imagekitCleanup.fileId,
        });
    }

    return updatedUser;
  });

  return result;
}
