import crypto from "crypto";
import type { Request, Response } from "express";
import { getEnv } from "../lib/env";

const env = getEnv();

const privateKey = env.IMAGEKIT_PRIVATE_KEY;

export const generateSignature = (_req: Request, res: Response) => {
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 2400;

  const signature = crypto
    .createHmac("sha1", privateKey)
    .update(token + expire)
    .digest("hex");

  res.setHeader("Cache-Control", "no-store");

  res.json({
    token,
    expire,
    signature,
  });
};
