import { getEnv } from "../../lib/env";

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const VERIFICATION_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 2048;

interface TurnstileSiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  "error-codes"?: string[];
}

export interface VerifyWaitlistTurnstileOptions {
  /**
   * Optional visitor IP address.
   * Only pass an IP address obtained from a trusted source.
   */
  remoteIp?: string;

  /**
   * Optional expected website hostname.
   * Example: eaglespress.com
   */
  expectedHostname?: string;

  /**
   * Optional expected Turnstile action.
   * Only use this if you configure an action on the widget.
   */
  expectedAction?: string;
}

export type TurnstileVerificationResult =
  | {
      success: true;
      hostname: string | undefined;
      action: string | undefined;
      challengeTimestamp: string | undefined;
    }
  | {
      success: false;
      reason:
        | "missing-token"
        | "invalid-token"
        | "hostname-mismatch"
        | "action-mismatch"
        | "verification-unavailable";
      errorCodes?: string[];
    };

/**
 * Verifies a Cloudflare Turnstile token using Cloudflare's
 * server-side Siteverify API.
 *
 * Tokens are single-use and expire after five minutes.
 *
 * The backend must never trust the frontend's claim that
 * a Turnstile challenge was successfully completed.
 */
export async function verifyWaitlistTurnstile(
  token: string,
  options: VerifyWaitlistTurnstileOptions = {},
): Promise<TurnstileVerificationResult> {
  // Reject missing or malformed tokens before contacting Cloudflare.
  if (typeof token !== "string" || !token.trim()) {
    return {
      success: false,
      reason: "missing-token",
    };
  }

  const normalizedToken = token.trim();

  if (normalizedToken.length > MAX_TOKEN_LENGTH) {
    return {
      success: false,
      reason: "invalid-token",
    };
  }

  // Retrieve the secret from the validated backend environment.
  const { TURNSTILE_SECRET_KEY } = getEnv();

  const formData = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: normalizedToken,
  });

  if (options.remoteIp?.trim()) {
    formData.set("remoteip", options.remoteIp.trim());
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
    });

    // Do not allow requests through when Cloudflare is unavailable.
    if (!response.ok) {
      return {
        success: false,
        reason: "verification-unavailable",
      };
    }

    const result: unknown = await response.json();

    // Validate the response before trusting it.
    if (
      typeof result !== "object" ||
      result === null ||
      !("success" in result) ||
      typeof result.success !== "boolean"
    ) {
      return {
        success: false,
        reason: "verification-unavailable",
      };
    }

    const verification = result as TurnstileSiteverifyResponse;

    // Cloudflare rejected the token.
    if (!verification.success) {
      const errorCodes = Array.isArray(verification["error-codes"])
        ? verification["error-codes"].filter(
            (code): code is string => typeof code === "string",
          )
        : [];

      /**
       * These errors indicate backend or verification-service
       * configuration failures, not invalid visitor tokens.
       *
       * A visitor cannot fix these problems by completing
       * another Turnstile challenge.
       */
      if (
        errorCodes.includes("internal-error") ||
        errorCodes.includes("invalid-input-secret")
      ) {
        return {
          success: false,
          reason: "verification-unavailable",
          errorCodes,
        };
      }

      // Actual visitor-token rejections remain invalid-token.
      return {
        success: false,
        reason: "invalid-token",
        errorCodes,
      };
    }

    // Optionally verify that the challenge came from the expected hostname.
    if (options.expectedHostname) {
      const expectedHostname = options.expectedHostname.trim().toLowerCase();

      const actualHostname = verification.hostname?.trim().toLowerCase();

      if (!actualHostname || actualHostname !== expectedHostname) {
        return {
          success: false,
          reason: "hostname-mismatch",
        };
      }
    }

    // Optionally verify the action configured on the Turnstile widget.
    if (options.expectedAction) {
      if (verification.action !== options.expectedAction) {
        return {
          success: false,
          reason: "action-mismatch",
        };
      }
    }

    return {
      success: true,
      hostname: verification.hostname,
      action: verification.action,
      challengeTimestamp: verification.challenge_ts,
    };
  } catch {
    // Includes network failures, timeouts and invalid JSON responses.
    // Fail closed: an unavailable verification service must not
    // result in an unverified waitlist subscription.
    return {
      success: false,
      reason: "verification-unavailable",
    };
  }
}
