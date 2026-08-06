import { initializeApp, cert, getApps, App } from "firebase-admin/app";
import { getMessaging, Messaging } from "firebase-admin/messaging";
import { eq } from "drizzle-orm";
import { deviceTokens } from "../db/schema";
import { getEnv } from "./env";
import { db } from "../db";

const env = getEnv();

// 🔐 Ensure singleton app (important for serverless / hot reload)
let app: App;

if (!getApps().length) {
  app = initializeApp({
    credential: cert({
      projectId: env.FCM_PROJECT_ID!,
      clientEmail: env.FCM_CLIENT_EMAIL!,
      privateKey: env.FCM_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    }),
  });
} else {
  app = getApps()[0]!;
}

// 📲 Messaging instance
export const fcm: Messaging = getMessaging(app);

// 🧠 Strongly typed payload (production-safe)
type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

// 🚀 Production-grade send function
export async function sendPush(token: string, payload: PushPayload) {
  try {
    return await fcm.send({
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data ?? {},
      android: {
        notification: {
          channelId: "default", // MUST match your app.json + client setup
          sound: "default",
          priority: "high",
        },
      },
    });
  } catch (err: any) {
    // 🔥 Handle invalid / expired tokens
    if (err?.code === "messaging/registration-token-not-registered") {
      await db.delete(deviceTokens).where(eq(deviceTokens.token, token));

      // Optional: log for observability
      console.warn("Deleted invalid FCM token:", token);

      throw new Error("INVALID_TOKEN");
    }

    // Optional: handle other retryable errors
    if (err?.code?.startsWith("messaging/")) {
      console.error("FCM error:", err.code, err.message);
    }

    throw err;
  }
}
