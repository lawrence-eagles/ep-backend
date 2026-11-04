import { z } from "zod";

export const userBlockParamsSchema = z.object({
  userId: z.string().min(1).max(128),
});

export type UserBlockParams = z.infer<typeof userBlockParamsSchema>;
