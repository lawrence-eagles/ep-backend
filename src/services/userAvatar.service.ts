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
   * Update the user and queue the old ImageKit file
   * inside the same PostgreSQL transaction.
   *
   * If anything fails, neither change is committed.
   */
  const result = await db.transaction(async (tx) => {
    const [currentUser] = await tx
      .select({
        id: user.id,
        image: user.image,
        imageFileId: user.imageFileId,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!currentUser) {
      throw new Error("User not found");
    }

    /*
     * If the user is already using this exact file,
     * there is nothing to clean up.
     */
    const oldImageFileId = currentUser.imageFileId ?? null;

    const imageFileChanged = oldImageFileId !== input.imageFileId;

    /*
     * Update both Better Auth's image URL and our
     * server-owned ImageKit file ID.
     */
    const [updatedUser] = await tx
      .update(user)
      .set({
        image: input.image,
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
     * This is intentionally done inside the same
     * transaction as the user update.
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
