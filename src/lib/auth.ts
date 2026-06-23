import "dotenv/config";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db"; // your drizzle instance
import { schema } from "../db/schema"; // the schema exported as const.
import { getEnv } from "../lib/env";

const env = getEnv();
const frontendOrigin = new URL(env.FRONTEND_URL).origin;

export const auth = betterAuth({
  trustedOrigins: [frontendOrigin],
  socialProviders: {
    facebook: {
      clientId: env.FACEBOOK_CLIENT_ID,
      clientSecret: env.FACEBOOK_CLIENT_SECRET,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  emailAndPassword: {
    enabled: true,
    // requireEmailVerification: true,
  },
  database: drizzleAdapter(db, {
    provider: "pg", // or "mysql", "sqlite"
    schema,
  }),
});
