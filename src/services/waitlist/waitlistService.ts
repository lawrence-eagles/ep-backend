import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "../../db";
import { waitlistEmailOutbox, waitlistSubscribers } from "../../db/schema";

import {
  createSecureToken,
  decryptPayload,
  encryptPayload,
  hashToken,
} from "./waitlistTokens";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Minimum remaining verification-token lifetime before reusing
 * an existing token without extending its expiration.
 *
 * If the remaining lifetime is below this threshold, the existing
 * token's expiration is extended before its email is queued.
 *
 * This preserves the existing link while providing sufficient
 * time for email delivery and recipient action.
 */
const MIN_REMAINING_VERIFICATION_TTL_MS = 60 * 60 * 1000;

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

  const updated = await db.transaction(async (tx) => {
    // Re-read the subscriber inside the transaction so that the
    // token and expiry information used below are current.
    const currentSubscriber = await tx.query.waitlistSubscribers.findFirst({
      where: and(
        eq(waitlistSubscribers.id, subscriber.id),
        eq(waitlistSubscribers.status, "pending"),
      ),
    });

    if (!currentSubscriber) {
      return false;
    }

    const now = new Date();

    const existingTokenIsValid =
      currentSubscriber.verificationTokenHash !== null &&
      currentSubscriber.verificationTokenExpiresAt !== null &&
      currentSubscriber.verificationTokenExpiresAt > now;

    let payloadEncrypted: string;

    let verification: ReturnType<typeof createSecureToken> | null = null;

    let shouldExtendTokenExpiry = false;

    if (existingTokenIsValid) {
      /**
       * Find the outbox payload associated with the subscriber's
       * CURRENT active verification token.
       *
       * Do not select by createdAt. PostgreSQL's createdAt default
       * can reflect transaction start time rather than insertion order.
       *
       * Decrypt each candidate and compare its token hash against
       * the subscriber's current verificationTokenHash.
       */
      const existingOutboxRows = await tx.query.waitlistEmailOutbox.findMany({
        where: and(
          eq(waitlistEmailOutbox.subscriberId, currentSubscriber.id),
          eq(waitlistEmailOutbox.type, "verification"),
        ),
      });

      const matchingOutbox = existingOutboxRows.find((outbox) => {
        try {
          const payload = decryptPayload<EmailPayload>(outbox.payloadEncrypted);

          return (
            typeof payload.email === "string" &&
            typeof payload.token === "string" &&
            hashToken(payload.token) === currentSubscriber.verificationTokenHash
          );
        } catch {
          // Ignore unreadable or invalid historical outbox payloads.
          return false;
        }
      });

      /**
       * Never invalidate an existing valid token when its matching
       * encrypted payload cannot be found.
       */
      if (!matchingOutbox) {
        return false;
      }

      payloadEncrypted = matchingOutbox.payloadEncrypted;

      /**
       * Preserve the existing verification link.
       *
       * When the token is approaching expiration, extend its lifetime
       * before queuing the resend. This prevents the recipient from
       * receiving a link that is about to expire.
       *
       * The token hash remains unchanged, so previously delivered
       * copies of the same verification link remain usable.
       */
      shouldExtendTokenExpiry =
        currentSubscriber.verificationTokenExpiresAt!.getTime() -
          now.getTime() <
        MIN_REMAINING_VERIFICATION_TTL_MS;
    } else {
      // The existing token has expired or is missing.
      // A new token is now required.
      verification = createSecureToken();

      payloadEncrypted = encryptPayload({
        email,
        token: verification.token,
      } satisfies EmailPayload);
    }

    // Update the resend timestamp atomically.
    // The cooldown condition prevents concurrent requests from
    // queueing multiple verification emails.
    const updateValues = verification
      ? {
          verificationTokenHash: verification.tokenHash,
          verificationTokenExpiresAt: new Date(
            now.getTime() + VERIFICATION_TTL_MS,
          ),
          verificationSentAt: now,
          updatedAt: now,
        }
      : shouldExtendTokenExpiry
        ? {
            verificationTokenExpiresAt: new Date(
              now.getTime() + VERIFICATION_TTL_MS,
            ),
            verificationSentAt: now,
            updatedAt: now,
          }
        : {
            verificationSentAt: now,
            updatedAt: now,
          };

    const [row] = await tx
      .update(waitlistSubscribers)
      .set(updateValues)
      .where(
        and(
          eq(waitlistSubscribers.id, currentSubscriber.id),
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

    // Queue the matching existing encrypted payload when the token
    // is still valid, or the newly generated payload when expired.
    await tx.insert(waitlistEmailOutbox).values({
      subscriberId: row.id,
      type: "verification",
      payloadEncrypted,
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
  const lookupNow = new Date();

  const subscriber = await db.query.waitlistSubscribers.findFirst({
    where: and(
      eq(waitlistSubscribers.verificationTokenHash, tokenHash),
      eq(waitlistSubscribers.status, "pending"),
      gt(waitlistSubscribers.verificationTokenExpiresAt, lookupNow),
    ),
  });

  if (!subscriber) {
    return { result: "invalid_or_expired" as const };
  }

  const unsubscribe = createSecureToken();

  const confirmed = await db.transaction(async (tx) => {
    /**
     * Use PostgreSQL's clock_timestamp() for the authoritative
     * expiration check.
     *
     * Unlike now(), clock_timestamp() advances during the transaction.
     * PostgreSQL can therefore evaluate the expiration predicate
     * against the actual statement execution time, including time
     * spent waiting for a concurrent row lock.
     */
    const [row] = await tx
      .update(waitlistSubscribers)
      .set({
        status: "confirmed",
        confirmedAt: sql<Date>`clock_timestamp()`,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        unsubscribeTokenHash: unsubscribe.tokenHash,
        updatedAt: sql<Date>`clock_timestamp()`,
      })
      .where(
        and(
          eq(waitlistSubscribers.id, subscriber.id),
          eq(waitlistSubscribers.status, "pending"),
          eq(waitlistSubscribers.verificationTokenHash, tokenHash),
          sql`${waitlistSubscribers.verificationTokenExpiresAt} > clock_timestamp()`,
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
