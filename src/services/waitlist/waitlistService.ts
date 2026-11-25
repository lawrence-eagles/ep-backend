import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import { db } from "../../db";
import { waitlistEmailOutbox, waitlistSubscribers } from "../../db/schema";

import { createSecureToken, encryptPayload, hashToken } from "./waitlistTokens";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

type EmailPayload = {
  email: string;
  token: string;
};

export async function subscribeToWaitlist(emailInput: string, source?: string) {
  const email = emailInput.trim().toLowerCase();

  const existing = await db.query.waitlistSubscribers.findFirst({
    where: eq(waitlistSubscribers.email, email),
  });

  if (existing?.status === "confirmed") {
    return { result: "already_confirmed" as const };
  }

  if (existing?.status === "pending") {
    return { result: "already_pending" as const };
  }

  if (existing?.status === "bounced") {
    return { result: "bounced" as const };
  }

  const verification = createSecureToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

  // Allow a previously unsubscribed subscriber to subscribe again.
  if (existing?.status === "unsubscribed") {
    const updated = await db.transaction(async (tx) => {
      const [subscriber] = await tx
        .update(waitlistSubscribers)
        .set({
          status: "pending",
          verificationTokenHash: verification.tokenHash,
          verificationTokenExpiresAt: expiresAt,
          verificationSentAt: new Date(),
          confirmedAt: null,
          unsubscribedAt: null,
          unsubscribeTokenHash: null,
          source: source ?? existing.source,
          consentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(waitlistSubscribers.id, existing.id),
            eq(waitlistSubscribers.status, "unsubscribed"),
          ),
        )
        .returning({
          id: waitlistSubscribers.id,
        });

      if (!subscriber) {
        return null;
      }

      await tx.insert(waitlistEmailOutbox).values({
        subscriberId: subscriber.id,
        type: "verification",
        payloadEncrypted: encryptPayload({
          email,
          token: verification.token,
        } satisfies EmailPayload),
      });

      return subscriber;
    });

    return {
      result: updated
        ? ("verification_sent" as const)
        : ("already_pending" as const),
    };
  }

  // Create a new subscriber and queue the verification email atomically.
  const inserted = await db.transaction(async (tx) => {
    const [subscriber] = await tx
      .insert(waitlistSubscribers)
      .values({
        email,
        status: "pending",
        verificationTokenHash: verification.tokenHash,
        verificationTokenExpiresAt: expiresAt,
        verificationSentAt: new Date(),
        source: source ?? null,
        consentAt: new Date(),
      })
      .onConflictDoNothing({
        target: waitlistSubscribers.email,
      })
      .returning({
        id: waitlistSubscribers.id,
      });

    if (!subscriber) {
      return null;
    }

    await tx.insert(waitlistEmailOutbox).values({
      subscriberId: subscriber.id,
      type: "verification",
      payloadEncrypted: encryptPayload({
        email,
        token: verification.token,
      } satisfies EmailPayload),
    });

    return subscriber;
  });

  return {
    result: inserted
      ? ("verification_sent" as const)
      : ("already_pending" as const),
  };
}

export async function resendWaitlistVerification(emailInput: string) {
  const email = emailInput.trim().toLowerCase();

  const subscriber = await db.query.waitlistSubscribers.findFirst({
    where: and(
      eq(waitlistSubscribers.email, email),
      eq(waitlistSubscribers.status, "pending"),
    ),
  });

  // Do not reveal whether an address is registered.
  if (!subscriber) {
    return { result: "request_received" as const };
  }

  // Fast preliminary check to avoid unnecessary database updates.
  // The atomic condition below remains the authoritative check.
  if (
    subscriber.verificationSentAt &&
    Date.now() - subscriber.verificationSentAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    return { result: "request_received" as const };
  }

  const verification = createSecureToken();
  const now = new Date();

  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(waitlistSubscribers)
      .set({
        verificationTokenHash: verification.tokenHash,
        verificationTokenExpiresAt: expiresAt,
        verificationSentAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(waitlistSubscribers.id, subscriber.id),
          eq(waitlistSubscribers.status, "pending"),
          or(
            isNull(waitlistSubscribers.verificationSentAt),
            lt(
              waitlistSubscribers.verificationSentAt,
              new Date(now.getTime() - RESEND_COOLDOWN_MS),
            ),
          ),
        ),
      )
      .returning({
        id: waitlistSubscribers.id,
      });

    // Another request may have updated the row first.
    // Do not enqueue an email if the atomic update did not succeed.
    if (!row) {
      return false;
    }

    await tx.insert(waitlistEmailOutbox).values({
      subscriberId: row.id,
      type: "verification",
      payloadEncrypted: encryptPayload({
        email,
        token: verification.token,
      } satisfies EmailPayload),
    });

    return true;
  });

  // Keep the response generic to avoid exposing subscriber information.
  return {
    result: updated
      ? ("request_received" as const)
      : ("request_received" as const),
  };
}

export async function verifyWaitlistEmail(token: string) {
  const tokenHash = hashToken(token);
  const now = new Date();

  const subscriber = await db.query.waitlistSubscribers.findFirst({
    where: and(
      eq(waitlistSubscribers.verificationTokenHash, tokenHash),
      eq(waitlistSubscribers.status, "pending"),
      gt(waitlistSubscribers.verificationTokenExpiresAt, now),
    ),
  });

  if (!subscriber) {
    return { result: "invalid_or_expired" as const };
  }

  const unsubscribe = createSecureToken();

  const confirmed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(waitlistSubscribers)
      .set({
        status: "confirmed",
        confirmedAt: now,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        unsubscribeTokenHash: unsubscribe.tokenHash,
        updatedAt: now,
      })
      .where(
        and(
          eq(waitlistSubscribers.id, subscriber.id),
          eq(waitlistSubscribers.status, "pending"),
          eq(waitlistSubscribers.verificationTokenHash, tokenHash),
          gt(waitlistSubscribers.verificationTokenExpiresAt, now),
        ),
      )
      .returning({
        id: waitlistSubscribers.id,
      });

    if (!row) {
      return false;
    }

    await tx.insert(waitlistEmailOutbox).values({
      subscriberId: row.id,
      type: "welcome",
      payloadEncrypted: encryptPayload({
        email: subscriber.email,
        token: unsubscribe.token,
      } satisfies EmailPayload),
    });

    return true;
  });

  return {
    result: confirmed
      ? ("confirmed" as const)
      : ("invalid_or_expired" as const),
  };
}

export async function unsubscribeFromWaitlist(token: string) {
  const tokenHash = hashToken(token);
  const now = new Date();

  const [subscriber] = await db
    .update(waitlistSubscribers)
    .set({
      status: "unsubscribed",
      unsubscribedAt: now,
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
      unsubscribeTokenHash: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(waitlistSubscribers.unsubscribeTokenHash, tokenHash),
        eq(waitlistSubscribers.status, "confirmed"),
      ),
    )
    .returning({
      id: waitlistSubscribers.id,
    });

  return subscriber
    ? { result: "unsubscribed" as const }
    : { result: "invalid_or_already_unsubscribed" as const };
}
