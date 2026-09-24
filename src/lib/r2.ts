import { getEnv } from "../lib/env";
import { S3Client } from "@aws-sdk/client-s3";

const env = getEnv();

const R2_ACCOUNT_ID = env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;

export const R2_BUCKET_NAME = env.R2_BUCKET_NAME;

export const r2 = new S3Client({
  region: "auto",

  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,

  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
