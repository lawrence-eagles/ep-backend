import "dotenv/config";
import { betterAuth } from "better-auth";
import { expo } from "@better-auth/expo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Resend } from "resend";
import VerifyEmail from "../emails/verifyEmail";
import ForgotPasswordEmail from "../emails/forgotPasswordEmail";
import { db } from "../db"; // your drizzle instance
import { schema } from "../db/schema"; // the schema exported as const.
import { getEnv } from "../lib/env";

const env = getEnv();
const frontendOrigin = new URL(env.FRONTEND_URL).origin;
const resend = new Resend(env.RESEND_API_KEY);

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  plugins: [expo()],
  trustedOrigins: [
    frontendOrigin,
    "eaglespress://",

    // Development mode - Expo's exp:// scheme with local IP ranges
    ...(process.env.NODE_ENV === "development"
      ? [
          "exp://", // Trust all Expo URLs (prefix matching)
          "exp://**", // Trust all Expo URLs (wildcard matching)
          "exp://192.168.*.*:*/**", // Trust 192.168.x.x IP range with any port and path
        ]
      : []),
  ],
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await resend.emails.send({
        from: `Eaglespress <noreply@${env.DOMAIN}>`,
        to: user.email,
        subject: "Verify your email",
        react: VerifyEmail({
          userName: user.name,
          verificationUrl: url,
        }),
      });
    },
  },
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
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await resend.emails.send({
        from: `Eaglespress <noreply@${env.DOMAIN}>`,
        to: user.email,
        subject: "Reset your password",
        react: ForgotPasswordEmail({
          userName: user.name,
          resetUrl: url,
        }),
      });
    },
    onPasswordReset: async ({ user }, request) => {
      // your logic here
      console.log(`Password for user ${user.id} has been reset.`);
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg", // or "mysql", "sqlite"
    schema,
  }),
});
