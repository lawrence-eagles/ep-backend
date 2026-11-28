import { and, eq, lte, or, inArray } from "drizzle-orm";
import { Resend } from "resend";
import type { InngestFunction } from "inngest";

import { inngest } from "../../lib/inngest";
import { getEnv } from "../../lib/env";
import { db } from "../../db";
import { waitlistEmailOutbox, waitlistSubscribers } from "../../db/schema";
import {
  decryptPayload,
  hashToken,
} from "../../services/waitlist/waitlistTokens";

const env = getEnv();
const resend = new Resend(env.RESEND_API_KEY);

type EmailPayload = {
  email: string;
  token: string;
};

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;
const LOCK_DURATION_MS = 5 * 60 * 1000;

const MAX_BATCHES_PER_RUN = 40;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };

    return replacements[character];
  });
}

function verificationEmail(token: string) {
  const url = new URL("/api/v1/waitlist/verify", env.BACKEND_URL);

  url.searchParams.set("token", token);

  return {
    subject: "Confirm your Eaglespress waiting-list subscription",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;line-height:1.6;color:#202124">
        <h2>Confirm your email address</h2>

        <p>Thanks for joining the Eaglespress waiting list.</p>

        <p>Confirm your email address to complete your subscription.</p>

        <p>
          <a
            href="${escapeHtml(url.toString())}"
            style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px"
          >
            Confirm my email
          </a>
        </p>

        <p>
          This link expires in 24 hours. If you did not request this,
          you can ignore this email.
        </p>

        <p style="font-size:12px;color:#777">
          Sent to ${escapeHtml("")}
        </p>
      </div>
    `,
  };
}

function welcomeEmail(unsubscribeToken: string) {
  const url = new URL("/waitlist/unsubscribe", env.FRONTEND_URL);

  url.searchParams.set("token", unsubscribeToken);

  return {
    subject: "You're on the Eaglespress waiting list!",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;line-height:1.6;color:#202124">
        <h2>You're on the list!</h2>

        <p>
          Your email has been confirmed. Thanks for your interest
          in Eaglespress.
        </p>

        <p>We'll email you when there's news to share.</p>

        <hr />

        <p style="font-size:12px;color:#777">
          You received this because you confirmed your Eaglespress
          waiting-list subscription.

          <a href="${escapeHtml(url.toString())}">
            Unsubscribe
          </a>
        </p>
      </div>
    `,
  };
}

export const deliverWaitlistEmails: InngestFunction.Any =
  inngest.createFunction(
    {
      id: "deliver-waitlist-emails",
      retries: 2,
      concurrency: {
        limit: 1,
      },
      triggers: {
        cron: "0 */6 * * *",
      },
    },
    async ({ step }) => {
      let totalProcessed = 0;
      let batchNumber = 0;

      // Keep claiming and processing batches until no eligible
      // emails remain in the outbox.
      while (batchNumber < MAX_BATCHES_PER_RUN) {
        const claimed = await step.run(
          `claim-waitlist-outbox-${batchNumber}`,
          async () => {
            return db.transaction(async (tx) => {
              const now = new Date();

              const rows = await tx
                .select()
                .from(waitlistEmailOutbox)
                .where(
                  and(
                    or(
                      eq(waitlistEmailOutbox.status, "pending"),
                      and(
                        eq(waitlistEmailOutbox.status, "processing"),
                        lte(waitlistEmailOutbox.lockedUntil, now),
                      ),
                    ),
                    lte(waitlistEmailOutbox.nextAttemptAt, now),
                  ),
                )
                .limit(BATCH_SIZE)
                .for("update", { skipLocked: true });

              if (rows.length === 0) {
                return [];
              }

              const ids = rows.map((row) => row.id);

              await tx
                .update(waitlistEmailOutbox)
                .set({
                  status: "processing",
                  lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
                })
                .where(inArray(waitlistEmailOutbox.id, ids));

              return rows;
            });
          },
        );

        // No more eligible emails. End the draining loop.
        if (claimed.length === 0) {
          break;
        }

        totalProcessed += claimed.length;

        // Process every email in the claimed batch.
        for (const item of claimed) {
          await step.run(`deliver-waitlist-email-${item.id}`, async () => {
            try {
              const payload = decryptPayload<EmailPayload>(
                item.payloadEncrypted,
              );

              const subscriber = await db.query.waitlistSubscribers.findFirst({
                where: eq(waitlistSubscribers.id, item.subscriberId),
              });

              // Do not send an old verification email if:
              // 1. The subscriber is no longer pending.
              // 2. A newer verification token has been issued.
              if (
                item.type === "verification" &&
                (subscriber?.status !== "pending" ||
                  subscriber.verificationTokenHash !== hashToken(payload.token))
              ) {
                await db
                  .update(waitlistEmailOutbox)
                  .set({
                    status: "sent",
                    sentAt: new Date(),
                    lockedUntil: null,
                  })
                  .where(eq(waitlistEmailOutbox.id, item.id));

                return;
              }

              // Do not send a welcome email if the subscriber
              // is no longer confirmed.
              if (
                item.type === "welcome" &&
                subscriber?.status !== "confirmed"
              ) {
                await db
                  .update(waitlistEmailOutbox)
                  .set({
                    status: "sent",
                    sentAt: new Date(),
                    lockedUntil: null,
                  })
                  .where(eq(waitlistEmailOutbox.id, item.id));

                return;
              }

              const emailContent =
                item.type === "verification"
                  ? verificationEmail(payload.token)
                  : welcomeEmail(payload.token);

              // Stable idempotency key:
              // The same outbox item always uses the same key.
              // Different outbox items receive different keys.
              const idempotencyKey = `waitlist-email/${item.id}`;

              const { error } = await resend.emails.send(
                {
                  from: `Eaglespress <noreply@${env.DOMAIN}>`,
                  to: payload.email,
                  subject: emailContent.subject,
                  html: emailContent.html,
                },
                {
                  idempotencyKey,
                },
              );

              if (error) {
                throw new Error(error.message);
              }

              await db
                .update(waitlistEmailOutbox)
                .set({
                  status: "sent",
                  sentAt: new Date(),
                  lockedUntil: null,
                  lastError: null,
                })
                .where(eq(waitlistEmailOutbox.id, item.id));
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : "Email delivery failed";

              const attempts = item.attempts + 1;
              const permanentlyFailed = attempts >= MAX_ATTEMPTS;

              await db
                .update(waitlistEmailOutbox)
                .set({
                  status: permanentlyFailed ? "failed" : "pending",
                  attempts,
                  nextAttemptAt: new Date(
                    Date.now() +
                      Math.min(60 * 60 * 1000, 2 ** attempts * 30_000),
                  ),
                  lockedUntil: null,
                  lastError: message.slice(0, 1000),
                })
                .where(eq(waitlistEmailOutbox.id, item.id));

              // The outbox now owns retry scheduling.
              // Do not throw after successfully persisting the retry state.
              // The next cron execution will claim this item only after
              // nextAttemptAt has elapsed and will read its updated attempts.
              return;
            }
          });
        }

        // Move to the next batch.
        // Each iteration has a unique Inngest step ID.
        batchNumber++;
      }

      return {
        processed: totalProcessed,
        batches: batchNumber,
      };
    },
  );
