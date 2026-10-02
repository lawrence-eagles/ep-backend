// apps/api/src/lib/imagekit.ts
import ImageKit from "@imagekit/nodejs";
import { getEnv } from "../lib/env";

const env = getEnv();

export const imagekit = new ImageKit({
  privateKey: env.IMAGEKIT_PRIVATE_KEY,
});

// Treat "already gone" as success so account deletion never fails on a 404
export async function deleteImageKitFile(fileId: string): Promise<void> {
  try {
    await imagekit.files.delete(fileId);
  } catch (err) {
    if (err instanceof ImageKit.APIError && err.status === 404) {
      return;
    }

    throw err;
  }
}
