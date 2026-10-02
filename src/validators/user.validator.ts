import { z } from "zod";

export const updateAvatarSchema = z.object({
  imageFileId: z.string().trim().min(1, "Image file ID is required"),

  image: z.string().trim().url("Invalid image URL"),
});

export type UpdateAvatarInput = z.infer<typeof updateAvatarSchema>;
