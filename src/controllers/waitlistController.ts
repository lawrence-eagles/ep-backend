import type { Request, Response } from "express";
import { isIP } from "node:net";
import { z } from "zod";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import { db } from "../db";
import { waitlistSubscribers } from "../db/schema";
import { getEnv } from "../lib/env";

import {
  subscribeToWaitlist,
  resendWaitlistVerification,
  verifyWaitlistEmail,
  unsubscribeFromWaitlist,
} from "../services/waitlist/waitlistService";

import { verifyWaitlistTurnstile } from "../services/waitlist/waitlistTurnstile";

const env = getEnv();

// ─────────────────────────────────────────────
// 🔒 SAFE DATABASE ERROR LOGGING
// ─────────────────────────────────────────────

/**
 * Logs only a fixed operation name and a validated PostgreSQL SQLSTATE.
 *
 * Never log the error object or its message: database errors may contain
 * bound query parameters, including subscriber email addresses.
 */
type WaitlistOperation =
  | "subscribe"
  | "resend_verification"
  | "verify"
  | "unsubscribe"
  | "admin_list_subscribers"
  | "admin_stats"
  | "admin_export_subscribers";

function getSafeDatabaseErrorCode(error: unknown): string {
  let current: unknown = error;

  // Drizzle/driver errors may expose the PostgreSQL error through `cause`.
  // Limit traversal depth and inspect only the `code` property.
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth++
  ) {
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
    };

    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate.code;
    }

    current = candidate.cause;
  }

  return "unknown";
}

function logWaitlistError(operation: WaitlistOperation, error: unknown): void {
  console.error("WAITLIST_ERROR", {
    operation,
    code: getSafeDatabaseErrorCode(error),
  });
}

// ─────────────────────────────────────────────
// 🔐 TURNSTILE CONFIGURATION
// ─────────────────────────────────────────────

const ALLOWED_TURNSTILE_HOSTNAMES = new Set([
  "eaglespress.com",
  "www.eaglespress.com",
]);

const TURNSTILE_EXPECTED_ACTION = "waitlist";

const subscribeSchema = z.object({
  email: z.email().max(254),
  source: z.string().trim().max(100).optional(),
  consent: z.literal(true),
  turnstileToken: z.string().trim().min(1).max(2048),
});

const emailSchema = z.object({
  email: z.email().max(254),
});

const resendVerificationSchema = emailSchema.extend({
  turnstileToken: z.string().trim().min(1).max(2048),
});

const tokenSchema = z.object({
  token: z.string().min(20).max(200),
});

type TurnstileControllerResult =
  | { success: true }
  | {
      success: false;
      statusCode: 400 | 503;
      message: string;
    };

/**
 * Resolves the visitor IP supplied by Railway's public HTTP ingress.
 *
 * Do not use req.ip here because Express trust proxy is disabled.
 * With that setting, req.ip identifies the immediate connection,
 * which is normally Railway's ingress proxy rather than the visitor.
 *
 * Railway's public HTTP ingress supplies X-Real-IP. Validate the
 * header before passing it to Cloudflare as the optional remoteip.
 *
 * If the header is missing or invalid, return undefined so the
 * Turnstile service omits the optional remoteip parameter.
 *
 * This resolver assumes requests reach this application through
 * Railway's public HTTP ingress, not an unsanitized private-network path.
 */
function getTrustedVisitorIp(req: Request): string | undefined {
  const realIp = req.get("x-real-ip")?.trim();

  if (!realIp || isIP(realIp) === 0) {
    return undefined;
  }

  return realIp;
}

/**
 * Verifies a Turnstile token and checks that it was generated
 * for one of the approved Eaglespress website hostnames and
 * the expected "waitlist" action.
 */
async function validateTurnstile(
  req: Request,
  token: string,
): Promise<TurnstileControllerResult> {
  const remoteIp = getTrustedVisitorIp(req);

  const verification = await verifyWaitlistTurnstile(token, {
    remoteIp,
    expectedAction: TURNSTILE_EXPECTED_ACTION,
  });

  if (!verification.success) {
    if (verification.reason === "verification-unavailable") {
      return {
        success: false,
        statusCode: 503,
        message:
          "We are temporarily unable to verify your request. Please try again shortly.",
      };
    }

    return {
      success: false,
      statusCode: 400,
      message:
        "Security verification failed. Please complete the verification and try again.",
    };
  }

  const hostname = verification.hostname?.trim().toLowerCase();

  if (!hostname || !ALLOWED_TURNSTILE_HOSTNAMES.has(hostname)) {
    return {
      success: false,
      statusCode: 400,
      message:
        "Security verification failed. Please refresh the page and try again.",
    };
  }

  return { success: true };
}

// ─────────────────────────────────────────────
// 🔗 FRONTEND REDIRECT
// ─────────────────────────────────────────────

function frontendRedirect(path: string, status: string): string {
  const url = new URL(path, env.FRONTEND_URL);

  url.searchParams.set("status", status);

  return url.toString();
}

// ─────────────────────────────────────────────
// 🚀 PUBLIC WAITLIST ENDPOINTS
// ─────────────────────────────────────────────

export async function subscribe(req: Request, res: Response) {
  const parsed = subscribeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error:
        "Please provide a valid email address, accept the waiting-list consent, and complete security verification.",
      issues: parsed.error.issues,
    });
  }

  try {
    const turnstileResult = await validateTurnstile(
      req,
      parsed.data.turnstileToken,
    );

    if (!turnstileResult.success) {
      return res.status(turnstileResult.statusCode).json({
        error: turnstileResult.message,
      });
    }

    await subscribeToWaitlist(parsed.data.email, parsed.data.source);

    // Keep the public response identical for every valid signup state.
    // State-specific mail decisions remain inside the service.
    return res.status(202).json({
      status: "accepted",
      message:
        "If this address can be added, a confirmation email will be sent.",
    });
  } catch (error) {
    logWaitlistError("subscribe", error);

    return res.status(500).json({
      error: "Unable to process your request right now.",
    });
  }
}

export async function resendVerification(req: Request, res: Response) {
  const parsed = resendVerificationSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error:
        "Please provide a valid email address and complete security verification.",
      issues: parsed.error.issues,
    });
  }

  try {
    const turnstileResult = await validateTurnstile(
      req,
      parsed.data.turnstileToken,
    );

    if (!turnstileResult.success) {
      return res.status(turnstileResult.statusCode).json({
        error: turnstileResult.message,
      });
    }

    await resendWaitlistVerification(parsed.data.email);

    // Deliberately identical whether the email exists or not.
    return res.status(202).json({
      message:
        "If a pending subscription exists, a new verification email will be sent.",
    });
  } catch (error) {
    logWaitlistError("resend_verification", error);

    return res.status(500).json({
      error: "Unable to process your request right now.",
    });
  }
}

export async function verify(req: Request, res: Response) {
  const parsed = tokenSchema.safeParse(req.query);

  if (!parsed.success) {
    return res.redirect(303, frontendRedirect("/waitlist/verified", "invalid"));
  }

  try {
    const result = await verifyWaitlistEmail(parsed.data.token);

    return res.redirect(
      303,
      frontendRedirect(
        "/waitlist/verified",
        result.result === "confirmed" ? "success" : "invalid",
      ),
    );
  } catch (error) {
    logWaitlistError("verify", error);

    return res.redirect(303, frontendRedirect("/waitlist/verified", "error"));
  }
}

export async function unsubscribe(req: Request, res: Response) {
  const parsed = tokenSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid unsubscribe token.",
    });
  }

  try {
    const result = await unsubscribeFromWaitlist(parsed.data.token);

    if (result.result === "unsubscribed") {
      return res.status(200).json({
        status: "unsubscribed",
        message: "You have been removed from the Eaglespress waiting list.",
      });
    }

    return res.status(400).json({
      error: "This unsubscribe link is invalid or has already been used.",
    });
  } catch (error) {
    logWaitlistError("unsubscribe", error);

    return res.status(500).json({
      error: "Unable to process your request right now.",
    });
  }
}

// ─────────────────────────────────────────────
// 🔎 PRIVACY-PRESERVING STATUS CHECK
// ─────────────────────────────────────────────

// This endpoint does not disclose whether an address is pending,
// confirmed, unsubscribed, bounced, or absent.
export async function statusCheck(req: Request, res: Response) {
  const parsed = emailSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Please provide a valid email address.",
    });
  }

  return res.status(200).json({
    message: "We cannot disclose subscription status through this endpoint.",
  });
}

// ─────────────────────────────────────────────
// 🛠️ ADMIN ENDPOINTS
// ─────────────────────────────────────────────

const adminListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(["pending", "confirmed", "unsubscribed", "bounced"])
    .optional(),
  search: z.string().trim().max(254).optional(),
});

export async function adminListSubscribers(req: Request, res: Response) {
  const parsed = adminListSchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid query parameters.",
    });
  }

  const { page, limit, status, search } = parsed.data;

  const filters: SQL[] = [];

  if (status) {
    filters.push(eq(waitlistSubscribers.status, status));
  }

  if (search) {
    filters.push(ilike(waitlistSubscribers.email, `%${search}%`));
  }

  const where = filters.length ? and(...filters) : undefined;

  try {
    const [subscribers, totalResult] = await Promise.all([
      db
        .select({
          id: waitlistSubscribers.id,
          email: waitlistSubscribers.email,
          status: waitlistSubscribers.status,
          source: waitlistSubscribers.source,
          consentAt: waitlistSubscribers.consentAt,
          confirmedAt: waitlistSubscribers.confirmedAt,
          unsubscribedAt: waitlistSubscribers.unsubscribedAt,
          createdAt: waitlistSubscribers.createdAt,
        })
        .from(waitlistSubscribers)
        .where(where)
        .orderBy(
          desc(waitlistSubscribers.createdAt),
          desc(waitlistSubscribers.id),
        )
        .limit(limit)
        .offset((page - 1) * limit),

      db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(waitlistSubscribers)
        .where(where),
    ]);

    const total = totalResult[0]?.count ?? 0;

    return res.status(200).json({
      data: subscribers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logWaitlistError("admin_list_subscribers", error);

    return res.status(500).json({
      error: "Unable to load subscribers.",
    });
  }
}

export async function adminWaitlistStats(_req: Request, res: Response) {
  try {
    const rows = await db
      .select({
        status: waitlistSubscribers.status,
        count: sql<number>`count(*)::int`,
      })
      .from(waitlistSubscribers)
      .groupBy(waitlistSubscribers.status);

    const stats = {
      total: 0,
      pending: 0,
      confirmed: 0,
      unsubscribed: 0,
      bounced: 0,
    };

    for (const row of rows) {
      stats[row.status] = row.count;
      stats.total += row.count;
    }

    return res.status(200).json(stats);
  } catch (error) {
    logWaitlistError("admin_stats", error);

    return res.status(500).json({
      error: "Unable to load waitlist statistics.",
    });
  }
}

// ─────────────────────────────────────────────
// 📤 ADMIN CSV EXPORT
// ─────────────────────────────────────────────

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);

  // Prevent spreadsheet formula injection.
  if (/^[\s]*[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

export async function adminExportSubscribers(_req: Request, res: Response) {
  try {
    const rows = await db
      .select({
        email: waitlistSubscribers.email,
        status: waitlistSubscribers.status,
        source: waitlistSubscribers.source,
        consentAt: waitlistSubscribers.consentAt,
        confirmedAt: waitlistSubscribers.confirmedAt,
        unsubscribedAt: waitlistSubscribers.unsubscribedAt,
        createdAt: waitlistSubscribers.createdAt,
      })
      .from(waitlistSubscribers)
      .orderBy(desc(waitlistSubscribers.createdAt));

    const headers = [
      "email",
      "status",
      "source",
      "consent_at",
      "confirmed_at",
      "unsubscribed_at",
      "created_at",
    ];

    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map((row) =>
        [
          row.email,
          row.status,
          row.source,
          row.consentAt?.toISOString(),
          row.confirmedAt?.toISOString(),
          row.unsubscribedAt?.toISOString(),
          row.createdAt.toISOString(),
        ]
          .map(csvCell)
          .join(","),
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="eaglespress-waitlist.csv"',
    );

    return res.status(200).send(lines.join("\r\n"));
  } catch (error) {
    logWaitlistError("admin_export_subscribers", error);

    return res.status(500).json({
      error: "Unable to export subscribers.",
    });
  }
}
