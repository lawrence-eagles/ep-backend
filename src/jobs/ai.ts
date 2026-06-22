import "dotenv/config";
import type { SummaryResult } from "./types";
import { getEnv } from "../lib/env";

const env = getEnv();

// ── OpenAI API types ───────────────────────────────────────────────────────────
//
// OpenAI response shape:
//   { choices: [{ message: { role: "assistant", content: string | null } }] }
//
// Anthropic response shape (previous):
//   { content: [{ type: "text", text: string }], stop_reason, usage }

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
    };
    finish_reason: "stop" | "length" | "content_filter";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Retry with exponential backoff ────────────────────────────────────────────
// Handles transient network failures and OpenAI 429 / 503 responses.

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError;
}

// ── Batch summarize articles using gpt-4o-mini ────────────────────────────────
//
// OpenAI API differs from Anthropic in these key ways:
//
//   Auth:     Authorization: Bearer ${OPENAI_API_KEY}
//             (Anthropic used: x-api-key + anthropic-version headers)
//
//   Endpoint: https://api.openai.com/v1/chat/completions
//             (Anthropic used: https://api.anthropic.com/v1/messages)
//
//   System:   Passed as { role: "system", content: "..." } inside messages[]
//             (Anthropic used a top-level `system` string field — NOT messages[])
//
//   Response: choices[0].message.content  (string | null)
//             (Anthropic used: content[].find(b => b.type==="text")?.text)

export async function batchSummarize(
  contents: string[],
): Promise<SummaryResult[]> {
  if (contents.length === 0) return [];

  // Trim each content to stay within token limits (~375 tokens at 4 chars/token)
  const trimmed = contents.map((c) => c.slice(0, 1_500));

  const userPrompt = trimmed
    .map((c, i) => `Article ${i + 1}:\n${c}`)
    .join("\n\n---\n\n");

  // Explicit JSON schema in the prompt prevents hallucinated response structures.
  // temperature: 0.3 keeps output consistent and close to the specified format.
  const systemPrompt = `
You are a news summarization assistant for Eaglespress, a news aggregator app.
Summarize each article in exactly 4 clear, factual, SEO-friendly sentences.

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
The array must have exactly ${contents.length} objects in this exact shape:
[
  { "index": 1, "summary": "Sentence one. Sentence two. Sentence three." },
  { "index": 2, "summary": "Sentence one. Sentence two. Sentence three." }
]
`.trim();

  try {
    const result = await withRetry(async () => {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: {
            "Content-Type": "application/json",
            // OpenAI uses Authorization: Bearer — not x-api-key
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.3,
            // ~80 tokens per summary; minimum 512 to avoid truncation on small batches
            max_tokens: Math.max(contents.length * 80, 512),
            // OpenAI: system prompt goes inside messages[] as role:"system"
            // NOT as a top-level `system` field — that is Anthropic-specific
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ] satisfies OpenAIMessage[],
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as OpenAIResponse;

      // OpenAI returns the text directly at choices[0].message.content
      const raw = data.choices[0]?.message?.content?.trim();

      if (!raw) {
        throw new Error("OpenAI returned empty content");
      }

      // Strip accidental markdown code fences — model sometimes adds them
      // despite explicit instructions not to
      const clean = raw
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(clean) as SummaryResult[];

      if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array, got: ${typeof parsed}`);
      }

      if (parsed.length !== contents.length) {
        throw new Error(
          `Expected ${contents.length} summaries, got ${parsed.length}`,
        );
      }

      return parsed;
    });

    // Validate every item — fall back per-item if the model skipped one
    return contents.map((content, i) => {
      const item = result.find((r) => r.index === i + 1);

      if (item?.summary && typeof item.summary === "string") {
        return { index: i + 1, summary: item.summary };
      }

      console.warn(`[ai] Missing summary for article ${i + 1}, using fallback`);
      return { index: i + 1, summary: content.slice(0, 200) };
    });
  } catch (err) {
    // Full batch fallback — log the real error, return truncated content
    console.error("[ai] batchSummarize failed after retries:", err);
    return contents.map((content, i) => ({
      index: i + 1,
      summary: content.slice(0, 200),
    }));
  }
}
