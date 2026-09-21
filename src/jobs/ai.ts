import "dotenv/config";
import type { SummaryResult } from "./types";
import { getEnv } from "../lib/env";

const env = getEnv();

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const OPENAI_MODEL = "gpt-5.6-luna";

/**
 * fetchNews.ts currently sends 5 articles per AI batch.
 *
 * This is also enforced here defensively so that another caller cannot
 * accidentally create an oversized OpenAI request.
 */
const MAX_ARTICLES_PER_REQUEST = 5;

/**
 * Maximum article content sent to OpenAI per article.
 *
 * Keeping this bounded prevents unusually large scraped pages from creating
 * unnecessarily expensive input requests.
 */
const MAX_ARTICLE_CHARS = 1_500;

/**
 * Output budget allocated per article.
 *
 * Each article must produce exactly 4 concise sentences plus the surrounding
 * Structured Outputs JSON envelope.
 *
 * 150+ tokens/article gives the model considerably more room than the previous
 * 100-token budget while remaining inexpensive for Eaglespress.
 */
const OUTPUT_TOKENS_PER_ARTICLE = 160;

/**
 * Minimum output budget for any request.
 *
 * For a normal 5-article fetchNews.ts batch:
 *
 *   5 × 160 = 800
 *
 * Therefore a 5-article request receives 800 output tokens.
 *
 * This is intentionally above the previous 512-token budget, which could
 * deterministically truncate a 5-article response.
 */
const MIN_OUTPUT_TOKENS = 800;

/**
 * Individual OpenAI HTTP request timeout.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Total number of attempts, including the initial request.
 */
const MAX_RETRIES = 3;

/**
 * Initial exponential backoff delay.
 *
 * Approximate retry delays:
 *
 *   retry 1 → 500ms + jitter
 *   retry 2 → 1000ms + jitter
 */
const INITIAL_RETRY_DELAY_MS = 500;

/**
 * Maximum random jitter added to retry delays.
 */
const MAX_RETRY_JITTER_MS = 250;

/**
 * Maximum amount of time this module will wait for an OpenAI Retry-After
 * value inside a single application request.
 *
 * OpenAI can return a very large Retry-After value when an organization has
 * exhausted its token-per-minute allowance. Sleeping for hours inside an
 * Inngest step keeps the HTTP request open and can cause the hosting proxy to
 * return a 502 before the Inngest SDK can respond.
 *
 * Long rate-limit recovery belongs to a later Inngest invocation rather than
 * an in-process timer, so values above this limit are treated as non-retryable
 * for the current request.
 */
const MAX_RETRY_AFTER_MS = 10_000;

// ───────────────────────────────────────────────────────────────────────────────
// TYPES
// ───────────────────────────────────────────────────────────────────────────────

interface OpenAIErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: string | null;
    param?: string | null;
  };
}

interface OpenAIOutputContent {
  type?: string;
  text?: string;
  refusal?: string;
}

interface OpenAIOutputItem {
  type?: string;
  content?: OpenAIOutputContent[] | null;
}

interface OpenAIResponse {
  id: string;
  object: "response";
  model: string;

  status:
    | "completed"
    | "failed"
    | "in_progress"
    | "queued"
    | "cancelled"
    | "incomplete"
    | string;

  output?: OpenAIOutputItem[] | null;

  error?: {
    code?: string;
    message?: string;
  } | null;

  incomplete_details?: {
    reason?: string;
  } | null;

  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;

    input_tokens_details?: {
      cached_tokens?: number;
    };

    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/**
 * Internal error used to distinguish retryable failures from permanent
 * failures.
 */
class OpenAIRequestError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: {
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
    },
  ) {
    super(message);

    this.name = "OpenAIRequestError";
    this.retryable = options?.retryable ?? false;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// RETRY
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Retry transient OpenAI/network failures using exponential backoff and
 * jitter.
 *
 * IMPORTANT:
 *
 * A response that is incomplete specifically because max_output_tokens was
 * reached is NOT retryable. Sending the exact same request with the exact same
 * output limit would deterministically produce the same truncation.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const retryable =
        error instanceof OpenAIRequestError ? error.retryable : false;

      if (!retryable) {
        throw error;
      }

      if (attempt >= retries - 1) {
        throw error;
      }

      const retryAfterMs =
        error instanceof OpenAIRequestError ? error.retryAfterMs : undefined;

      /**
       * Never keep the process alive for a long OpenAI rate-limit window.
       *
       * This is especially important for 429 TPM limits. A Retry-After value
       * can legitimately be hours long, but waiting that long inside this
       * function does not help the current Inngest invocation and can cause
       * the upstream HTTP request to expire with a 502.
       *
       * The caller already has a full-batch fallback, so a long rate-limit
       * response should fail fast and let the current batch degrade safely.
       */
      if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
        console.warn(
          `[ai] OpenAI requested a retry after ${retryAfterMs}ms, ` +
            `which exceeds the ${MAX_RETRY_AFTER_MS}ms in-process retry limit. ` +
            `Skipping the retry so the batch can use its fallback.`,
          error,
        );

        throw error;
      }

      const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

      const jitter = Math.floor(Math.random() * (MAX_RETRY_JITTER_MS + 1));

      const delay = Math.min(
        MAX_RETRY_AFTER_MS,
        Math.max(retryAfterMs ?? 0, exponentialDelay + jitter),
      );

      console.warn(
        `[ai] OpenAI request failed ` +
          `(attempt ${attempt + 1}/${retries}). ` +
          `Retrying in ${delay}ms.`,
        error,
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenAI request failed after retries");
}

// ───────────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Parse OpenAI's Retry-After header.
 *
 * Supports both:
 *
 *   Retry-After: 5
 *
 * and HTTP-date values.
 */
function getRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const retryDate = Date.parse(retryAfter);

  if (!Number.isNaN(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return undefined;
}

/**
 * Limit article content before sending it to OpenAI.
 */
function trimArticle(content: string): string {
  return content.slice(0, MAX_ARTICLE_CHARS);
}

/**
 * Create the full-batch fallback requested by Eaglespress.
 *
 * IMPORTANT:
 * This intentionally uses 500 characters.
 */
function createFallbackSummary(content: string, index: number): SummaryResult {
  return {
    index,
    summary: content.slice(0, 500),
  };
}

/**
 * Safely extract generated text from the raw Responses API response.
 *
 * With fetch(), we receive the raw JSON response. We therefore explicitly
 * traverse:
 *
 * response.output[]
 *   → message
 *   → content[]
 *   → output_text
 *   → text
 *
 * We do not rely on an SDK-created `output_text` convenience property.
 */
function extractOutputText(data: OpenAIResponse): string {
  const output = data.output ?? [];

  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return text;
}

/**
 * Detect a model refusal in the Responses API output.
 */
function extractRefusal(data: OpenAIResponse): string | undefined {
  const output = data.output ?? [];

  for (const item of output) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal" && part.refusal) {
        return part.refusal;
      }
    }
  }

  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────────
// STRUCTURED OUTPUT SCHEMA
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Structured Outputs JSON schema.
 *
 * The application performs additional validation after parsing the response.
 *
 * We intentionally keep the JSON Schema simple and avoid unnecessary schema
 * constraints that are not needed because the application validates:
 *
 * - article count
 * - indexes
 * - duplicate indexes
 * - missing indexes
 * - non-empty summaries
 */
function createSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,

    properties: {
      summaries: {
        type: "array",

        items: {
          type: "object",
          additionalProperties: false,

          properties: {
            index: {
              type: "integer",
            },

            summary: {
              type: "string",
            },
          },

          required: ["index", "summary"],
        },
      },
    },

    required: ["summaries"],
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// PROMPTS
// ───────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(articleCount: number): string {
  return `
You are the news summarization engine for Eaglespress, an AI-powered news aggregation app.

Summarize every supplied news article independently.

For each article:

1. Write exactly 4 clear sentences.
2. Keep the summary factual and concise.
3. Preserve important facts, names, organizations, events, numbers, dates, and relevant context.
4. Do not invent facts.
5. Do not speculate.
6. Do not add opinions that are not supported by the article.
7. Do not use clickbait language.
8. Do not mention that you are an AI.
9. Do not combine multiple articles into one summary.
10. Do not skip any article.
11. The index must correspond to the supplied article number.
12. Produce exactly ${articleCount} summaries.

The summaries should be useful to a reader who has not read the original article.

Return the result using exactly the supplied Structured Outputs schema.
`.trim();
}

function buildUserPrompt(contents: string[]): string {
  return contents
    .map((content, index) => `Article ${index + 1}:\n${trimArticle(content)}`)
    .join("\n\n---\n\n");
}

// ───────────────────────────────────────────────────────────────────────────────
// VALIDATE STRUCTURED OUTPUT
// ───────────────────────────────────────────────────────────────────────────────

function validateSummaries(
  parsed: unknown,
  articleCount: number,
): SummaryResult[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new OpenAIRequestError("OpenAI structured output is not an object", {
      retryable: true,
    });
  }

  if (!("summaries" in parsed)) {
    throw new OpenAIRequestError(
      "OpenAI structured output is missing the summaries field",
      {
        retryable: true,
      },
    );
  }

  const summaries = (parsed as { summaries?: unknown }).summaries;

  if (!Array.isArray(summaries)) {
    throw new OpenAIRequestError(
      "OpenAI structured output summaries field is not an array",
      {
        retryable: true,
      },
    );
  }

  if (summaries.length !== articleCount) {
    throw new OpenAIRequestError(
      `Expected ${articleCount} summaries, got ${summaries.length}`,
      {
        retryable: true,
      },
    );
  }

  const validated: SummaryResult[] = [];

  for (let i = 0; i < summaries.length; i += 1) {
    const item = summaries[i];

    if (typeof item !== "object" || item === null) {
      throw new OpenAIRequestError(
        `Invalid summary object at position ${i + 1}`,
        {
          retryable: true,
        },
      );
    }

    if (!("index" in item) || !("summary" in item)) {
      throw new OpenAIRequestError(
        `Summary at position ${i + 1} is missing index or summary`,
        {
          retryable: true,
        },
      );
    }

    const index = (item as { index?: unknown }).index;
    const summary = (item as { summary?: unknown }).summary;

    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > articleCount
    ) {
      throw new OpenAIRequestError(
        `Invalid article index at position ${i + 1}`,
        {
          retryable: true,
        },
      );
    }

    if (typeof summary !== "string" || summary.trim().length === 0) {
      throw new OpenAIRequestError(`Empty summary for article ${index}`, {
        retryable: true,
      });
    }

    validated.push({
      index,
      summary: summary.trim(),
    });
  }

  /**
   * Ensure every article index occurs exactly once.
   */
  const indexes = new Set<number>();

  for (const result of validated) {
    if (indexes.has(result.index)) {
      throw new OpenAIRequestError(
        `Duplicate summary index returned: ${result.index}`,
        {
          retryable: true,
        },
      );
    }

    indexes.add(result.index);
  }

  for (let index = 1; index <= articleCount; index += 1) {
    if (!indexes.has(index)) {
      throw new OpenAIRequestError(`Missing summary for article ${index}`, {
        retryable: true,
      });
    }
  }

  /**
   * Normalize the result into the original article order.
   */
  return Array.from({ length: articleCount }, (_, offset) => {
    const index = offset + 1;

    const result = validated.find((item) => item.index === index);

    if (!result) {
      throw new OpenAIRequestError(
        `Unable to locate summary for article ${index}`,
        {
          retryable: true,
        },
      );
    }

    return {
      index,
      summary: result.summary,
    };
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// SINGLE OPENAI REQUEST
// ───────────────────────────────────────────────────────────────────────────────

async function summarizeBatch(contents: string[]): Promise<SummaryResult[]> {
  if (contents.length === 0) {
    return [];
  }

  const systemPrompt = buildSystemPrompt(contents.length);
  const userPrompt = buildUserPrompt(contents);

  /**
   * Calculate an output budget based on article count.
   *
   * For the normal 5-article batch:
   *
   *   5 × 160 = 800
   *
   * Therefore the request receives 800 output tokens.
   */
  const maxOutputTokens = Math.max(
    contents.length * OUTPUT_TOKENS_PER_ARTICLE,
    MIN_OUTPUT_TOKENS,
  );

  return withRetry(async () => {
    let response: Response;

    // ─────────────────────────────────────────────────────────────────────────
    // REQUEST
    // ─────────────────────────────────────────────────────────────────────────

    try {
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },

        body: JSON.stringify({
          model: OPENAI_MODEL,

          /**
           * Article summarization does not require deliberate multi-step
           * reasoning. `none` reduces unnecessary reasoning overhead and
           * keeps this high-volume workload efficient.
           */
          reasoning: {
            effort: "none",
          },

          /**
           * Eaglespress persists the resulting summary itself, so there is
           * no need to store the OpenAI response for later retrieval.
           */
          store: false,

          /**
           * Responses API equivalent of a system message.
           */
          instructions: systemPrompt,

          /**
           * Article batch.
           */
          input: userPrompt,

          /**
           * Structured Outputs guarantees that the model's successful
           * response conforms to our supplied JSON schema.
           */
          text: {
            format: {
              type: "json_schema",
              name: "eaglespress_article_summaries",
              strict: true,
              schema: createSummarySchema(),
            },
          },

          /**
           * Hard output boundary.
           */
          max_output_tokens: maxOutputTokens,
        }),
      });
    } catch (error) {
      /**
       * Network-level failures are retryable.
       *
       * Examples:
       * - DNS failure
       * - connection reset
       * - socket failure
       * - request timeout
       * - temporary network interruption
       */
      throw new OpenAIRequestError(
        `OpenAI network request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          retryable: true,
        },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HTTP ERROR HANDLING
    // ─────────────────────────────────────────────────────────────────────────

    if (!response.ok) {
      const body = await response.text();

      let errorMessage = body;

      try {
        const parsed = JSON.parse(body) as OpenAIErrorResponse;

        if (parsed.error?.message) {
          errorMessage = parsed.error.message;
        }
      } catch {
        /**
         * The server returned a non-JSON error body.
         *
         * Keep the original response body.
         */
      }

      /**
       * These statuses are considered transient for this workload.
       */
      const retryableStatuses = new Set([408, 409, 429, 500, 502, 503, 504]);

      throw new OpenAIRequestError(
        `OpenAI API error ${response.status}: ${errorMessage}`,
        {
          retryable: retryableStatuses.has(response.status),
          status: response.status,
          retryAfterMs:
            response.status === 429 ? getRetryAfterMs(response) : undefined,
        },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RESPONSE PARSING
    // ─────────────────────────────────────────────────────────────────────────

    let data: OpenAIResponse;

    try {
      data = (await response.json()) as OpenAIResponse;
    } catch (error) {
      /**
       * A successful HTTP response that cannot be parsed as JSON is treated
       * as transient because the response itself may have been corrupted or
       * interrupted.
       */
      throw new OpenAIRequestError(
        `Failed to parse OpenAI response JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          retryable: true,
        },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RESPONSE STATUS
    // ─────────────────────────────────────────────────────────────────────────

    if (data.status !== "completed") {
      const incompleteReason = data.incomplete_details?.reason;

      const message =
        data.error?.message ??
        (incompleteReason
          ? `OpenAI response incomplete: ${incompleteReason}`
          : `OpenAI response status was "${data.status}"`);

      /**
       * IMPORTANT:
       *
       * `incomplete + max_output_tokens` is deterministic.
       *
       * Retrying the same request with the same max_output_tokens would send
       * the same request again and can produce the same truncation while
       * unnecessarily increasing API cost.
       *
       * Therefore it is explicitly NON-RETRYABLE.
       */
      const retryable =
        (data.status === "incomplete" &&
          incompleteReason !== "max_output_tokens") ||
        data.status === "in_progress" ||
        data.status === "queued";

      throw new OpenAIRequestError(message, {
        retryable,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REFUSAL HANDLING
    // ─────────────────────────────────────────────────────────────────────────

    const refusal = extractRefusal(data);

    if (refusal) {
      /**
       * A refusal is not normally solved by sending the exact same request
       * again, so do not spend additional tokens retrying it.
       */
      throw new OpenAIRequestError(
        `OpenAI refused the summarization request: ${refusal}`,
        {
          retryable: false,
        },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXTRACT GENERATED TEXT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * With raw fetch() calls, explicitly traverse the Responses API output:
     *
     * output[]
     *   → message
     *   → content[]
     *   → output_text
     *   → text
     *
     * Do NOT use data.output_text here.
     */
    const raw = extractOutputText(data);

    if (!raw) {
      throw new OpenAIRequestError("OpenAI returned empty output text", {
        retryable: true,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PARSE STRUCTURED JSON
    // ─────────────────────────────────────────────────────────────────────────

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      /**
       * Structured Outputs should normally prevent malformed JSON.
       *
       * Keep this defensive retry because an unexpected malformed response
       * may be transient.
       */
      throw new OpenAIRequestError(
        `Failed to parse OpenAI structured output as JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          retryable: true,
        },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VALIDATE + NORMALIZE
    // ─────────────────────────────────────────────────────────────────────────

    return validateSummaries(parsed, contents.length);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Summarize multiple articles using GPT-5.6 Luna.
 *
 * PUBLIC CONTRACT — DO NOT CHANGE:
 *
 *   batchSummarize(contents: string[]): Promise<SummaryResult[]>
 *
 * This matches the existing fetchNews.ts pipeline:
 *
 *   const summaries = await batchSummarize(
 *     aiBatch.map(
 *       (article: ScrapedArticle) => article.content as string,
 *     ),
 *   );
 *
 * Therefore fetchNews.ts does not need to change.
 */
export async function batchSummarize(
  contents: string[],
): Promise<SummaryResult[]> {
  if (contents.length === 0) {
    return [];
  }

  /**
   * Defensive internal batching.
   *
   * fetchNews.ts already sends 5 articles per batch, but this protects this
   * function if another caller passes more than 5.
   */
  const requestBatches: string[][] = [];

  for (
    let start = 0;
    start < contents.length;
    start += MAX_ARTICLES_PER_REQUEST
  ) {
    requestBatches.push(
      contents.slice(start, start + MAX_ARTICLES_PER_REQUEST),
    );
  }

  try {
    const allResults: SummaryResult[] = [];

    /**
     * Process internal batches sequentially.
     *
     * fetchNews.ts already controls concurrency with:
     *
     *   AI_BATCH_CONCURRENCY = 3
     *
     * Adding another concurrency layer here would multiply the number of
     * simultaneous OpenAI requests.
     */
    for (const requestBatch of requestBatches) {
      const batchResults = await summarizeBatch(requestBatch);

      allResults.push(...batchResults);
    }

    /**
     * Re-index results against the original contents array.
     */
    const normalizedResults: SummaryResult[] = [];

    let offset = 0;

    for (const requestBatch of requestBatches) {
      for (let i = 0; i < requestBatch.length; i += 1) {
        const result = allResults[offset + i];

        if (!result) {
          throw new OpenAIRequestError(
            `Missing summary result for article ${offset + i + 1}`,
            {
              retryable: false,
            },
          );
        }

        normalizedResults.push({
          index: offset + i + 1,
          summary: result.summary,
        });
      }

      offset += requestBatch.length;
    }

    return normalizedResults;
  } catch (error) {
    // ─────────────────────────────────────────────────────────────────────────
    // FULL-BATCH FALLBACK
    // ─────────────────────────────────────────────────────────────────────────
    //
    // IMPORTANT:
    //
    // 1. Log the actual error.
    // 2. Do not throw the error into fetchNews.ts.
    // 3. Return one fallback for every article.
    // 4. Use the requested 500-character fallback.
    // ─────────────────────────────────────────────────────────────────────────

    console.error("[ai] batchSummarize failed after retries:", error);

    return contents.map((content, index) =>
      createFallbackSummary(content, index + 1),
    );
  }
}
