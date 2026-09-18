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
 * Your fetchNews.ts already sends 5 articles per batch.
 *
 * This is kept as a defensive limit inside ai.ts as well, so this function
 * remains safe if another caller accidentally passes a larger array later.
 *
 * IMPORTANT:
 * This does NOT require any change to fetchNews.ts.
 */
const MAX_ARTICLES_PER_REQUEST = 5;

/**
 * Maximum amount of article text sent to OpenAI for each article.
 *
 * This is the main input-token cost control.
 *
 * 1,500 characters is enough to give the model meaningful article context
 * while preventing unusually large scraped articles from creating expensive
 * requests.
 */
const MAX_ARTICLE_CHARS = 1_500;

/**
 * Maximum visible output budget allocated per article.
 *
 * The model is instructed to produce exactly four sentences, so 100 tokens
 * per article gives it enough room without allowing unnecessarily large
 * output.
 */
const OUTPUT_TOKENS_PER_ARTICLE = 100;

/**
 * Minimum output budget for a request.
 *
 * This prevents very small batches from receiving an unnecessarily tiny
 * output budget.
 */
const MIN_OUTPUT_TOKENS = 512;

/**
 * Individual OpenAI request timeout.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Total number of attempts, including the initial request.
 */
const MAX_RETRIES = 3;

/**
 * Initial exponential-backoff delay.
 *
 * Retry delays are approximately:
 *
 * attempt 1 → immediate
 * attempt 2 → 500ms + jitter
 * attempt 3 → 1000ms + jitter
 */
const INITIAL_RETRY_DELAY_MS = 500;

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

  /**
   * Responses API provides the final generated text here.
   *
   * Because we use Structured Outputs, this contains JSON matching our
   * supplied schema.
   */
  output_text?: string;

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
 * Internal error used to distinguish retryable OpenAI failures from
 * permanent failures.
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
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// RETRY
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Retry transient OpenAI/network failures using exponential backoff + jitter.
 *
 * Retryable HTTP statuses:
 *
 * 408 Request Timeout
 * 409 Conflict
 * 429 Rate Limited
 * 500 Internal Server Error
 * 502 Bad Gateway
 * 503 Service Unavailable
 * 504 Gateway Timeout
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
        error instanceof OpenAIRequestError
          ? error.retryable
          : typeof error === "object" &&
            error !== null &&
            "retryable" in error &&
            (error as { retryable?: boolean }).retryable === true;

      if (!retryable) {
        throw error;
      }

      if (attempt >= retries - 1) {
        throw error;
      }

      const retryAfterMs =
        error instanceof OpenAIRequestError ? error.retryAfterMs : undefined;

      const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

      /**
       * Jitter prevents concurrent Inngest AI batches from all retrying
       * simultaneously.
       */
      const jitter = Math.floor(Math.random() * 250);

      const delay = Math.max(retryAfterMs ?? 0, exponentialDelay + jitter);

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

  throw lastError;
}

// ───────────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Parse OpenAI's Retry-After header.
 *
 * OpenAI may provide either:
 *
 *   Retry-After: 5
 *
 * or an HTTP date.
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
 * Limit article content before it is sent to OpenAI.
 */
function trimArticle(content: string): string {
  return content.slice(0, MAX_ARTICLE_CHARS);
}

/**
 * Full-batch fallback requested for Eaglespress.
 *
 * IMPORTANT:
 * This intentionally uses 500 characters rather than 200.
 */
function createFallbackSummary(content: string, index: number): SummaryResult {
  return {
    index,
    summary: content.slice(0, 500),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// STRUCTURED OUTPUT SCHEMA
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Structured Outputs schema.
 *
 * We deliberately do not put minItems/maxItems or numeric minimum/maximum
 * constraints into this schema. The application validates those properties
 * after receiving the response.
 *
 * This keeps the schema simple and compatible with the supported Structured
 * Outputs JSON Schema subset.
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
6. Do not add opinions that are not present in the article.
7. Do not use clickbait language.
8. Do not mention that you are an AI.
9. Do not combine multiple articles into one summary.
10. Do not skip any article.
11. Each result's index must correspond to the supplied article number.
12. Produce exactly ${articleCount} summaries.

The summaries should be useful to a reader who has not read the original article.

The output must conform exactly to the supplied structured-output JSON schema.
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
   * Return in original input order rather than trusting the model's ordering.
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
   * Four sentences per article normally fit well below this limit.
   *
   * GPT-5.6 Luna's max output is much larger, but there is no reason for
   * Eaglespress to allow an article-summary request to generate huge output.
   */
  const maxOutputTokens = Math.max(
    contents.length * OUTPUT_TOKENS_PER_ARTICLE,
    MIN_OUTPUT_TOKENS,
  );

  return withRetry(async () => {
    let response: Response;

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
           * Summarization does not need deliberate multi-step reasoning.
           *
           * Using "none" minimizes unnecessary reasoning overhead and is
           * appropriate for this high-volume task.
           */
          reasoning: {
            effort: "none",
          },

          /**
           * Eaglespress stores the generated summary in PostgreSQL.
           *
           * There is no need for OpenAI to retain the response for a future
           * conversation turn.
           */
          store: false,

          /**
           * Responses API instructions replace the old Chat Completions
           * system message.
           */
          instructions: systemPrompt,

          /**
           * The article batch itself.
           */
          input: userPrompt,

          /**
           * Structured Outputs.
           *
           * This replaces the old:
           *
           * "Return ONLY valid JSON"
           *
           * prompt-based approach.
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
           * Hard output-cost/size boundary.
           */
          max_output_tokens: maxOutputTokens,
        }),
      });
    } catch (error) {
      /**
       * fetch() itself failed.
       *
       * Examples:
       * - DNS failure
       * - connection reset
       * - socket failure
       * - network interruption
       * - request timeout
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
         * Response wasn't JSON.
         *
         * Keep the original body.
         */
      }

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
    // PARSE RESPONSE
    // ─────────────────────────────────────────────────────────────────────────

    const data = (await response.json()) as OpenAIResponse;

    /**
     * We expect a completed Responses API response.
     */
    if (data.status !== "completed") {
      const message =
        data.error?.message ??
        data.incomplete_details?.reason ??
        `OpenAI response status was "${data.status}"`;

      /**
       * These statuses may be transient.
       */
      const retryable =
        data.status === "incomplete" ||
        data.status === "in_progress" ||
        data.status === "queued";

      throw new OpenAIRequestError(message, {
        retryable,
      });
    }

    /**
     * Responses API exposes the generated text through output_text.
     *
     * Because Structured Outputs is enabled, this should contain JSON
     * conforming to our schema.
     */
    const raw = data.output_text?.trim();

    if (!raw) {
      throw new OpenAIRequestError("OpenAI returned empty output_text", {
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
       * Structured Outputs should prevent malformed JSON.
       *
       * This defensive check protects the pipeline if the API ever returns
       * an unexpected response.
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
 * This matches the existing fetchNews.ts pipeline exactly:
 *
 *   const summaries = await batchSummarize(
 *     aiBatch.map((article) => article.content as string),
 *   );
 *
 * No fetchNews.ts changes are required.
 */
export async function batchSummarize(
  contents: string[],
): Promise<SummaryResult[]> {
  if (contents.length === 0) {
    return [];
  }

  /**
   * Normally fetchNews.ts sends exactly 5 articles here because:
   *
   *   AI_BATCH_SIZE = 5
   *
   * We still protect the function against a larger array.
   *
   * Each internal request contains at most 5 articles.
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
     * IMPORTANT:
     *
     * fetchNews.ts already runs up to 3 batchSummarize() calls concurrently.
     * Therefore we intentionally do NOT add another concurrency layer here.
     *
     * This prevents multiplying:
     *
     *   fetchNews concurrency × ai.ts concurrency
     *
     * and accidentally generating too many simultaneous OpenAI requests.
     */
    for (const requestBatch of requestBatches) {
      const batchResults = await summarizeBatch(requestBatch);

      allResults.push(...batchResults);
    }

    /**
     * summarizeBatch() indexes each internal request starting at 1.
     *
     * Convert those indexes back to the indexes of the original contents
     * array.
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
    // FULL BATCH FALLBACK
    // ─────────────────────────────────────────────────────────────────────────
    //
    // IMPORTANT:
    //
    // Preserve the original Eaglespress behavior:
    //
    // 1. Log the REAL error.
    // 2. Do NOT throw it back into fetchNews.ts.
    // 3. Return one fallback result for EVERY article.
    // 4. Use content.slice(0, 500).
    //
    // This means a temporary OpenAI failure does not crash the entire
    // fetch-news Inngest step.
    // ─────────────────────────────────────────────────────────────────────────

    console.error("[ai] batchSummarize failed after retries:", error);

    return contents.map((content, index) =>
      createFallbackSummary(content, index + 1),
    );
  }
}
