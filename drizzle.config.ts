/// <reference types="node" />
import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { getEnv } from "./src/lib/env";

const env = getEnv();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
