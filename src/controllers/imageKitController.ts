import crypto from "crypto";
import { v4 as uuid } from "uuid";
import type { Request, Response } from "express";

const privateKey = process.env.IMAGEKIT_PRIVATE_KEY!;

export const generateSignature = (req: Request, res: Response) => {
  const token = uuid();
  const expire = Math.floor(Date.now() / 1000) + 2400;

  const signature = crypto
    .createHmac("sha1", privateKey)
    .update(token + expire)
    .digest("hex");

  res.send({ token, expire, signature });
};
