import dns from "node:dns/promises";
import net from "node:net";

import Parser from "rss-parser";
import pLimit from "p-limit";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import type { InngestFunction } from "inngest";

import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { posts } from "../../db/schema";
import { getRedis } from "../../lib/redis";

import { FEEDS, getOrCreateSource } from "../source";
import { scrapeArticle } from "../scraper";
import { batchSummarize } from "../ai";
import { insertPostWithUniqueSlug } from "../../utils/slug";
import { detectCategoryId } from "../category";
import { calculatePostScore } from "../score";

import type { RawArticle, ScrapedArticle } from "../types";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const RSS_PARSER = new Parser({
  timeout: 10_000,
});

/**
 * Maximum number of feeds whose RSS requests are allowed to
 * execute concurrently inside the RSS step.
 */
const FEED_CONCURRENCY = 5;

/**
 * Maximum number of article scraping requests running at once
 * inside a processing batch.
 */
const SCRAPE_CONCURRENCY = 5;

/**
 * Number of article contents sent to the AI summarizer at once.
 */
const AI_BATCH_SIZE = 5;

/**
 * Maximum number of AI batches executing concurrently.
 */
const AI_BATCH_CONCURRENCY = 3;

/**
 * Maximum number of database saves executing concurrently.
 */
const SAVE_CONCURRENCY = 10;

/**
 * Number of articles processed by one durable Inngest step.
 *
 * Full scraped content stays inside this step and is NEVER
 * returned to Inngest.
 */
const PROCESS_BATCH_SIZE = 25;

/**
 * Number of URLs checked against Postgres in one query.
 */
const DB_QUERY_BATCH_SIZE = 100;

/**
 * Number of articles sent in one article.created event request.
 *
 * Inngest supports batching events, but event payload size is
 * also limited, so keeping this small is intentional.
 */
const EVENT_BATCH_SIZE = 25;

/**
 * Redis dedupe marker lifetime.
 */
const DEDUPE_TTL_SECONDS = 86_400;

/**
 * Maximum number of RSS items accepted from one feed.
 */
const MAX_ITEMS_PER_FEED = 20;

/**
 * Minimum article body size considered useful.
 */
const MIN_CONTENT_LENGTH = 200;

/**
 * RSS descriptions can be unexpectedly large. They are only a
 * fallback for scraping, so keep them bounded.
 */
const MAX_RSS_DESCRIPTION_LENGTH = 4_000;

/**
 * Maximum number of redirects followed during URL validation.
 */
const MAX_REDIRECTS = 5;

/**
 * Timeout for an individual article scrape.
 */
const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Timeout for Redis operations.
 */
const REDIS_TIMEOUT_MS = 2_000;

/**
 * Timeout for DNS resolution.
 */
const DNS_TIMEOUT_MS = 3_000;

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type Feed = (typeof FEEDS)[number];

type ProcessBatchResult = {
  processed: number;
  savedPostIds: string[];
  failed: number;
};

type SavedPost = {
  id: string;
  categoryId: string;
  title: string;
  description: string | null;
  slug: string;
  url: string;
};

type ArticleCreatedEventData = {
  postId: string;
  categoryId: string;
  title: string;
  summary: string;
  slug: string;
};

// ─────────────────────────────────────────────────────────────
// URL / SSRF PROTECTION
// ─────────────────────────────────────────────────────────────

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;

  // 0.0.0.0/8
  if (a === 0) {
    return true;
  }

  // 10.0.0.0/8
  if (a === 10) {
    return true;
  }

  // 127.0.0.0/8
  if (a === 127) {
    return true;
  }

  // 169.254.0.0/16
  if (a === 169 && b === 254) {
    return true;
  }

  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  // 192.168.0.0/16
  if (a === 192 && b === 168) {
    return true;
  }

  // 100.64.0.0/10 - carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }

  // 198.18.0.0/15 - benchmarking
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }

  // 224.0.0.0/4 - multicast
  if (a >= 224 && a <= 239) {
    return true;
  }

  // 240.0.0.0/4 - reserved
  if (a >= 240) {
    return true;
  }

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  // IPv6 loopback
  if (normalized === "::1") {
    return true;
  }

  // IPv6 unspecified
  if (normalized === "::") {
    return true;
  }

  /**
   * IPv4-mapped IPv6 addresses:
   *
   * ::ffff:127.0.0.1
   * ::ffff:10.0.0.1
   * ::ffff:192.168.1.1
   */
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mappedMatch) {
    return isPrivateIPv4(mappedMatch[1]);
  }

  /**
   * IPv4-compatible / IPv4-embedded forms.
   */
  const lastColon = normalized.lastIndexOf(":");

  if (lastColon !== -1) {
    const possibleIPv4 = normalized.slice(lastColon + 1);

    if (possibleIPv4.includes(".") && net.isIP(possibleIPv4) === 4) {
      if (isPrivateIPv4(possibleIPv4)) {
        return true;
      }
    }
  }

  /**
   * fc00::/7 - Unique Local Addresses.
   */
  const firstGroup = normalized.split(":").find(Boolean);

  if (firstGroup) {
    const first16 = Number.parseInt(firstGroup, 16);

    if (Number.isInteger(first16) && (first16 & 0xfe00) === 0xfc00) {
      return true;
    }

    /**
     * fe80::/10 - link-local.
     */
    if (Number.isInteger(first16) && (first16 & 0xffc0) === 0xfe80) {
      return true;
    }

    /**
     * ff00::/8 - multicast.
     */
    if (Number.isInteger(first16) && (first16 & 0xff00) === 0xff00) {
      return true;
    }
  }

  return false;
}

function isPrivateAddress(address: string): boolean {
  const ipVersion = net.isIP(address);

  if (ipVersion === 4) {
    return isPrivateIPv4(address);
  }

  if (ipVersion === 6) {
    return isPrivateIPv6(address);
  }

  return true;
}

/**
 * Performs lexical URL validation.
 *
 * This is only the first SSRF defense.
 *
 * DNS resolution and redirect validation are performed separately
 * before scrapeArticle is called.
 */
function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);

    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }

    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[/, "")
      .replace(/\]$/, "");

    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return false;
    }

    /**
     * Explicit IPv4 validation.
     *
     * This also blocks 0.0.0.0.
     */
    if (net.isIP(hostname) === 4) {
      return !isPrivateIPv4(hostname);
    }

    /**
     * Explicit IPv6 validation.
     *
     * This blocks:
     *
     * ::1
     * ::
     * fc00::/7
     * fe80::/10
     * IPv4-mapped private addresses
     * multicast
     */
    if (net.isIP(hostname) === 6) {
      return !isPrivateIPv6(hostname);
    }

    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.search = "";
    parsed.hash = "";

    return parsed.toString();
  } catch {
    return url;
  }
}

const getDedupeKey = (url: string): string =>
  `seen:article:${normalizeUrl(url)}`;

function safeDate(input?: string | null): string | null {
  if (!input) {
    return null;
  }

  const date = new Date(input);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}…`;
}

// ─────────────────────────────────────────────────────────────
// TIMEOUT HELPER
// ─────────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Operation timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// DNS SSRF VALIDATION
// ─────────────────────────────────────────────────────────────

async function resolveAndValidateHostname(hostname: string): Promise<void> {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw new Error(`Blocked localhost hostname: ${hostname}`);
  }

  const ipVersion = net.isIP(normalized);

  if (ipVersion !== 0) {
    if (isPrivateAddress(normalized)) {
      throw new Error(`Blocked private IP address: ${hostname}`);
    }

    return;
  }

  let addresses: Array<{ address: string; family: number }>;

  try {
    addresses = await withTimeout(
      dns.lookup(normalized, {
        all: true,
        verbatim: true,
      }),
      DNS_TIMEOUT_MS,
    );
  } catch (error) {
    throw new TransientUrlValidationError(
      `Transient DNS validation failure for hostname: ${hostname}`,
      { cause: error },
    );
  }

  if (!addresses.length) {
    throw new Error(`Hostname did not resolve: ${hostname}`);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address.address)) {
      throw new Error(
        `Hostname resolves to a private address: ${hostname} -> ${address.address}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
class TransientUrlValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientUrlValidationError";
  }
}

// REDIRECT VALIDATION
// ─────────────────────────────────────────────────────────────

function getRedirectUrl(currentUrl: string, response: Response): string | null {
  const location = response.headers.get("location");

  if (!location) {
    return null;
  }

  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Validate the complete redirect chain before passing the URL
 * to the article scraper.
 *
 * Each hostname is DNS-resolved and every redirect target is
 * checked independently.
 *
 * NOTE:
 * scrapeArticle is an existing project helper and accepts only
 * a URL. This preflight prevents feed-controlled URLs and known
 * redirect chains from reaching it unless every hop is safe.
 */
async function validateUrlRedirectChain(rawUrl: string): Promise<void> {
  if (!isSafeUrl(rawUrl)) {
    throw new Error(`Unsafe article URL: ${rawUrl}`);
  }

  let currentUrl = rawUrl;

  const visited = new Set<string>();

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const normalized = normalizeUrl(currentUrl);

    if (visited.has(normalized)) {
      throw new Error(`Redirect loop detected: ${currentUrl}`);
    }

    visited.add(normalized);

    const parsed = new URL(currentUrl);

    if (!isSafeUrl(currentUrl)) {
      throw new Error(`Unsafe redirect URL: ${currentUrl}`);
    }

    await resolveAndValidateHostname(parsed.hostname);

    let response: Response;

    try {
      response = await withTimeout(
        fetch(currentUrl, {
          method: "HEAD",
          redirect: "manual",
          headers: {
            "User-Agent": "Eaglespress/1.0 (+https://eaglespress.com)",
          },
        }),
        SCRAPE_TIMEOUT_MS,
      );
    } catch (headError) {
      /**
       * Some servers reject HEAD requests. A small GET request
       * is used as the validation fallback.
       */
      try {
        response = await withTimeout(
          fetch(currentUrl, {
            method: "GET",
            redirect: "manual",
            headers: {
              Range: "bytes=0-0",
              "User-Agent": "Eaglespress/1.0 (+https://eaglespress.com)",
            },
          }),
          SCRAPE_TIMEOUT_MS,
        );
      } catch (getError) {
        throw new TransientUrlValidationError(
          `Transient URL validation probe failure: ${currentUrl}`,
          { cause: getError ?? headError },
        );
      }
    }

    if (response.status < 300 || response.status >= 400) {
      return;
    }

    const nextUrl = getRedirectUrl(currentUrl, response);

    if (!nextUrl) {
      throw new Error(
        `Redirect response missing Location header: ${currentUrl}`,
      );
    }

    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`Too many redirects: ${rawUrl}`);
    }

    currentUrl = nextUrl;
  }
}

// ─────────────────────────────────────────────────────────────
// REDIS HELPERS
// ─────────────────────────────────────────────────────────────

async function safeRedis<T>(
  fn: (redis: Awaited<ReturnType<typeof getRedis>>) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    const redis = await getRedis();

    return await withTimeout(fn(redis), REDIS_TIMEOUT_MS);
  } catch {
    return fallback;
  }
}

async function safeRedisSet(key: string): Promise<void> {
  try {
    const redis = await getRedis();

    await withTimeout(
      redis.set(key, "1", {
        EX: DEDUPE_TTL_SECONDS,
      }),
      REDIS_TIMEOUT_MS,
    );
  } catch (error) {
    /**
     * Redis is an optimization/dedupe layer.
     *
     * Postgres remains the source of truth.
     */
    console.error("REDIS ERROR (non-blocking):", error);
  }
}

// ─────────────────────────────────────────────────────────────
// CONTENT QUALITY
// ─────────────────────────────────────────────────────────────

function isValidContent(content: string | null): boolean {
  if (!content) {
    return false;
  }

  const cleaned = content.replace(/\s+/g, " ").trim();

  if (cleaned.length < MIN_CONTENT_LENGTH) {
    return false;
  }

  const junkPatterns = [
    /please enable javascript to view this page/i,
    /you need to enable javascript to view this page/i,
    /enable javascript to view this page/i,
  ];

  if (junkPatterns.some((pattern) => pattern.test(cleaned))) {
    return false;
  }

  return cleaned.split(". ").length >= 3;
}

// ─────────────────────────────────────────────────────────────
// RSS SCHEMA
// ─────────────────────────────────────────────────────────────

const RssItemSchema = z.object({
  title: z.string().min(1),

  link: z.string().refine(isSafeUrl),

  contentSnippet: z.string().optional(),

  enclosure: z
    .object({
      url: z.string().refine(isSafeUrl),
    })
    .optional(),

  pubDate: z.string().optional(),
});

function parseRssItem(item: Parser.Item, feedUrl: string): RawArticle | null {
  const parsed = RssItemSchema.safeParse(item);

  if (!parsed.success) {
    return null;
  }

  const { title, link, contentSnippet, enclosure, pubDate } = parsed.data;

  return {
    title: title.trim(),

    url: normalizeUrl(link),

    description: truncateText(
      contentSnippet?.replace(/\s+/g, " ").trim() ?? "",
      MAX_RSS_DESCRIPTION_LENGTH,
    ),

    imageUrl: enclosure?.url ?? null,

    feedUrl,

    createdAt: safeDate(pubDate),
  };
}

// ─────────────────────────────────────────────────────────────
// SAFE ARTICLE SCRAPING
// ─────────────────────────────────────────────────────────────

async function scrapeOneArticle(article: RawArticle): Promise<ScrapedArticle> {
  /**
   * Deliberate validation/policy rejections must propagate.
   * Only transient DNS/probe failures may use the RSS fallback.
   */
  try {
    await validateUrlRedirectChain(article.url);
  } catch (error) {
    if (!(error instanceof TransientUrlValidationError)) {
      throw error;
    }

    return {
      ...article,
      content: isValidContent(article.description) ? article.description : null,
      imageUrl: article.imageUrl,
    };
  }

  try {
    const scraped = await withTimeout(
      scrapeArticle(article.url),
      SCRAPE_TIMEOUT_MS,
    );

    const content = isValidContent(scraped.content)
      ? scraped.content
      : isValidContent(article.description)
        ? article.description
        : null;

    return {
      ...article,
      content,
      imageUrl: scraped.imageUrl ?? article.imageUrl,
    };
  } catch {
    /**
     * Scraping failure falls back to the RSS description.
     * The caller counts this article as processed but failed if
     * no usable content remains.
     */
    return {
      ...article,
      content: isValidContent(article.description) ? article.description : null,
      imageUrl: article.imageUrl,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// POSTGRES URL DEDUPE
// ─────────────────────────────────────────────────────────────

async function findExistingUrls(urls: readonly string[]): Promise<Set<string>> {
  const existing = new Set<string>();

  for (let start = 0; start < urls.length; start += DB_QUERY_BATCH_SIZE) {
    const chunk = urls.slice(start, start + DB_QUERY_BATCH_SIZE);

    if (!chunk.length) {
      continue;
    }

    const rows = await db
      .select({
        url: posts.url,
      })
      .from(posts)
      .where(inArray(posts.url, chunk));

    for (const row of rows) {
      existing.add(row.url);
    }
  }

  return existing;
}

// ─────────────────────────────────────────────────────────────
// FUNCTION
// ─────────────────────────────────────────────────────────────

export const fetchNews: InngestFunction.Any = inngest.createFunction(
  {
    id: "fetch-news-production",

    name: "Fetch News from RSS Feeds",

    concurrency: {
      limit: 1,
    },

    triggers: {
      cron: "0 */6 * * *",
    },

    retries: 2,
  },

  async ({ step, logger }) => {
    // ───────────────────────────────────────────────────────
    // STEP 1: FETCH RSS FEEDS
    //
    // FEED_CONCURRENCY is intentionally used here.
    //
    // FEEDS is readonly, so we use its inferred Feed type
    // rather than passing it to a mutable unknown[] helper.
    // ───────────────────────────────────────────────────────

    const rawArticles = await step.run(
      "fetch-rss-feeds",
      async (): Promise<RawArticle[]> => {
        const limit = pLimit(FEED_CONCURRENCY);

        const feedResults = await Promise.allSettled(
          (FEEDS as readonly Feed[]).map((feed: Feed) =>
            limit(async (): Promise<RawArticle[]> => {
              try {
                const parsed = await RSS_PARSER.parseURL(feed.url);

                return parsed.items
                  .slice(0, MAX_ITEMS_PER_FEED)
                  .map((item) => parseRssItem(item, feed.url))
                  .filter((article): article is RawArticle => article !== null);
              } catch (error) {
                logger.warn(`Feed failed: ${feed.url}`, error);

                return [];
              }
            }),
          ),
        );

        const results: RawArticle[] = [];

        feedResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            results.push(...result.value);
          } else {
            logger.warn(`Feed failed: ${FEEDS[index].url}`, result.reason);
          }
        });

        return results;
      },
    );

    if (!rawArticles.length) {
      return {
        processed: 0,
        saved: 0,
        failed: 0,
      };
    }

    // ───────────────────────────────────────────────────────
    // MEMORY DEDUPE
    // ───────────────────────────────────────────────────────

    const memorySeen = new Set<string>();

    const memoryDeduped = rawArticles.filter((article: RawArticle) => {
      if (memorySeen.has(article.url)) {
        return false;
      }

      memorySeen.add(article.url);

      return true;
    });

    if (!memoryDeduped.length) {
      return {
        processed: 0,
        saved: 0,
        failed: 0,
      };
    }

    // ───────────────────────────────────────────────────────
    // STEP 2: REDIS + DATABASE DEDUPE
    // ───────────────────────────────────────────────────────

    const uniqueArticles = await step.run(
      "deduplicate",
      async (): Promise<RawArticle[]> => {
        const urls = memoryDeduped.map((article: RawArticle) => article.url);

        const keys = urls.map(getDedupeKey);

        const redisResults = await safeRedis(
          (redis) => redis.mGet(keys),

          new Array<string | null>(keys.length).fill(null),
        );

        const seen = new Set<string>();

        redisResults.forEach((value, index) => {
          if (value !== null) {
            seen.add(urls[index]);
          }
        });

        const notSeen = memoryDeduped.filter(
          (article: RawArticle) => !seen.has(article.url),
        );

        if (!notSeen.length) {
          return [];
        }

        const existingSet = await findExistingUrls(
          notSeen.map((article: RawArticle) => article.url),
        );

        return notSeen.filter(
          (article: RawArticle) => !existingSet.has(article.url),
        );
      },
    );

    if (!uniqueArticles.length) {
      return {
        processed: 0,
        saved: 0,
        failed: 0,
      };
    }

    // ───────────────────────────────────────────────────────
    // PROCESS IN DURABLE BATCHES
    //
    // IMPORTANT:
    //
    // Full article content stays entirely inside each
    // process-articles-N step.
    //
    // The step returns ONLY:
    //
    //   processed
    //   savedPostIds
    //   failed
    //
    // Therefore article bodies and AI content never become
    // Inngest step output.
    // ───────────────────────────────────────────────────────

    const processBatches: RawArticle[][] = [];

    for (
      let start = 0;
      start < uniqueArticles.length;
      start += PROCESS_BATCH_SIZE
    ) {
      processBatches.push(
        uniqueArticles.slice(start, start + PROCESS_BATCH_SIZE),
      );
    }

    let totalProcessed = 0;
    let totalSaved = 0;
    let totalFailed = 0;

    for (
      let batchIndex = 0;
      batchIndex < processBatches.length;
      batchIndex += 1
    ) {
      const batch = processBatches[batchIndex];

      const processResult = await step.run(
        `process-articles-${batchIndex}`,
        async (): Promise<ProcessBatchResult> => {
          /**
           * IMPORTANT:
           *
           * processed is the original chunk size.
           *
           * This fixes the CodeRabbit issue where rejected
           * scrapes and content-quality drops disappeared
           * from the aggregate counters.
           */
          const processed = batch.length;

          const scrapeLimit = pLimit(SCRAPE_CONCURRENCY);

          const scrapeResults = await Promise.allSettled(
            batch.map((article: RawArticle) =>
              scrapeLimit(() => scrapeOneArticle(article)),
            ),
          );

          const scrapedArticles: ScrapedArticle[] = [];

          for (const result of scrapeResults) {
            if (result.status === "fulfilled") {
              scrapedArticles.push(result.value);
            }
          }

          /**
           * Content-quality failures are counted as failures
           * because processed == batch.length.
           */
          const validArticles = scrapedArticles.filter(
            (article: ScrapedArticle) => isValidContent(article.content),
          );

          if (!validArticles.length) {
            return {
              processed,
              savedPostIds: [],
              failed: processed,
            };
          }

          // ─────────────────────────────────────────────
          // AI SUMMARIZATION
          // ─────────────────────────────────────────────

          const aiBatches: ScrapedArticle[][] = [];

          for (
            let start = 0;
            start < validArticles.length;
            start += AI_BATCH_SIZE
          ) {
            aiBatches.push(validArticles.slice(start, start + AI_BATCH_SIZE));
          }

          const aiLimit = pLimit(AI_BATCH_CONCURRENCY);

          const aiResults = await Promise.allSettled(
            aiBatches.map((aiBatch: ScrapedArticle[]) =>
              aiLimit(async () => {
                const summaries = await batchSummarize(
                  aiBatch.map(
                    (article: ScrapedArticle) => article.content as string,
                  ),
                );

                return {
                  articles: aiBatch,
                  summaries,
                };
              }),
            ),
          );

          const enrichedArticles: Array<{
            article: ScrapedArticle;
            summary: string | null;
          }> = [];

          aiResults.forEach((result, batchIndex) => {
            const aiBatch = aiBatches[batchIndex];

            aiBatch.forEach((article: ScrapedArticle, articleIndex) => {
              const summary =
                result.status === "fulfilled"
                  ? (result.value.summaries[articleIndex]?.summary ?? null)
                  : null;

              enrichedArticles.push({
                article,
                summary: summary?.trim() ?? null,
              });
            });
          });

          // ─────────────────────────────────────────────
          // SAVE TO POSTGRES
          // ─────────────────────────────────────────────

          const saveLimit = pLimit(SAVE_CONCURRENCY);

          const saveResults = await Promise.allSettled(
            enrichedArticles.map(({ article, summary }) =>
              saveLimit(async (): Promise<string | null> => {
                /**
                 * No AI summary means this article
                 * cannot become a post.
                 */
                if (!summary) {
                  return null;
                }

                const [source, categoryId] = await Promise.all([
                  getOrCreateSource(article.feedUrl),

                  detectCategoryId(`${article.title} ${article.content ?? ""}`),
                ]);

                const score = calculatePostScore({
                  title: article.title,

                  content: article.content ?? "",

                  hasImage: !!article.imageUrl,

                  createdAt: article.createdAt
                    ? new Date(article.createdAt)
                    : null,
                });

                const inserted = await insertPostWithUniqueSlug({
                  title: article.title,

                  description: summary,

                  url: article.url,

                  imageUrl: article.imageUrl,

                  sourceId: source.id,

                  categoryId,

                  score,

                  createdAt: article.createdAt
                    ? new Date(article.createdAt)
                    : new Date(),
                }).catch((error: unknown) => {
                  logger.warn(`Failed to save article: ${article.url}`, error);

                  return null;
                });

                return inserted ? inserted.id : null;
              }),
            ),
          );

          const savedPostIds: string[] = [];

          for (const result of saveResults) {
            if (result.status === "fulfilled" && result.value !== null) {
              savedPostIds.push(result.value);
            }
          }

          /**
           * Everything in the original batch that did not
           * result in a saved post is considered failed.
           *
           * processed = batch.length
           * saved = savedPostIds.length
           * failed = processed - saved
           */
          return {
            processed,
            savedPostIds,
            failed: processed - savedPostIds.length,
          };
        },
      );

      totalProcessed += processResult.processed;

      totalSaved += processResult.savedPostIds.length;

      totalFailed += processResult.failed;

      // ───────────────────────────────────────────────────
      // SEND article.created FOR THIS BATCH ONLY
      //
      // We do NOT collect notification payloads for the
      // entire function run.
      // ───────────────────────────────────────────────────

      if (processResult.savedPostIds.length > 0) {
        const postIds = processResult.savedPostIds;

        const eventBatches: string[][] = [];

        for (let start = 0; start < postIds.length; start += EVENT_BATCH_SIZE) {
          eventBatches.push(postIds.slice(start, start + EVENT_BATCH_SIZE));
        }

        for (
          let eventBatchIndex = 0;
          eventBatchIndex < eventBatches.length;
          eventBatchIndex += 1
        ) {
          const eventPostIds = eventBatches[eventBatchIndex];

          /**
           * Load the saved posts inside one durable step.
           *
           * The result is deliberately bounded to EVENT_BATCH_SIZE.
           */
          const savedPosts = await step.run(
            `get-event-posts-${batchIndex}-${eventBatchIndex}`,
            async (): Promise<SavedPost[]> => {
              const rows = await db
                .select({
                  id: posts.id,
                  categoryId: posts.categoryId,
                  title: posts.title,
                  description: posts.description,
                  slug: posts.slug,
                  url: posts.url,
                })
                .from(posts)
                .where(inArray(posts.id, eventPostIds));

              return rows;
            },
          );

          if (!savedPosts.length) {
            continue;
          }

          const events = savedPosts.map((post: SavedPost) => ({
            id: `article-created-${post.id}`,

            name: "article.created",

            data: {
              postId: post.id,

              categoryId: post.categoryId,

              title: post.title,

              summary: post.description ?? "",

              slug: post.slug,
            } satisfies ArticleCreatedEventData,
          }));

          await step.sendEvent(
            `send-article-created-${batchIndex}-${eventBatchIndex}`,
            events,
          );

          // ─────────────────────────────────────────────
          // REDIS DEDUPE FOR THIS SAME BATCH
          // ─────────────────────────────────────────────

          await step.run(
            `mark-redis-${batchIndex}-${eventBatchIndex}`,
            async (): Promise<{
              marked: number;
            }> => {
              await Promise.all(
                savedPosts.map((post: SavedPost) =>
                  safeRedisSet(getDedupeKey(post.url)),
                ),
              );

              return {
                marked: savedPosts.length,
              };
            },
          );
        }
      }
    }

    // ───────────────────────────────────────────────────────
    // FINAL RESULT
    //
    // Only counters leave the function.
    // ───────────────────────────────────────────────────────

    return {
      processed: totalProcessed,

      saved: totalSaved,

      failed: totalFailed,
    };
  },
);
