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

/**
 * Errors caused by temporary network conditions during URL
 * validation. These are safe to handle by falling back to the
 * RSS description.
 *
 * Deliberate URL-policy violations use ordinary Error and MUST
 * propagate to the caller.
 */
class TransientUrlValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientUrlValidationError";
  }
}

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

/**
 * Expand an IPv6 address into its eight 16-bit hexadecimal
 * groups.
 *
 * IPv6 URLs may contain compressed notation, for example:
 *
 *   ::1
 *   ::ffff:7f00:1
 *   2001:db8::1
 *
 * IPv4-embedded notation is also supported:
 *
 *   ::ffff:127.0.0.1
 */
function expandIPv6(address: string): number[] | null {
  let normalized = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  if (!normalized) {
    return null;
  }

  /**
   * Convert an IPv4 suffix into two IPv6 16-bit groups.
   *
   * Example:
   *
   * 127.0.0.1
   *
   * becomes:
   *
   * 0x7f00, 0x0001
   */
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");

    if (lastColon === -1) {
      return null;
    }

    const ipv4Part = normalized.slice(lastColon + 1);

    if (net.isIP(ipv4Part) !== 4 || !isValidIPv4(ipv4Part)) {
      return null;
    }

    const ipv4Parts = ipv4Part.split(".").map(Number);

    const high = (ipv4Parts[0] << 8) | ipv4Parts[1];
    const low = (ipv4Parts[2] << 8) | ipv4Parts[3];

    normalized = `${normalized.slice(0, lastColon)}:${high.toString(
      16,
    )}:${low.toString(16)}`;
  }

  const doubleColonParts = normalized.split("::");

  if (doubleColonParts.length > 2) {
    return null;
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];

  const right = doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter(Boolean)
    : [];

  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }

    const value = Number.parseInt(group, 16);

    return Number.isInteger(value) && value >= 0 && value <= 0xffff
      ? value
      : null;
  };

  const leftGroups = left.map(parseGroup);
  const rightGroups = right.map(parseGroup);

  if (
    leftGroups.some((value) => value === null) ||
    rightGroups.some((value) => value === null)
  ) {
    return null;
  }

  const leftValues = leftGroups as number[];
  const rightValues = rightGroups as number[];

  if (doubleColonParts.length === 1) {
    if (leftValues.length !== 8) {
      return null;
    }

    return leftValues;
  }

  const missingGroups = 8 - leftValues.length - rightValues.length;

  if (missingGroups < 1) {
    return null;
  }

  return [
    ...leftValues,
    ...new Array<number>(missingGroups).fill(0),
    ...rightValues,
  ];
}

function isValidIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);

  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  const groups = expandIPv6(normalized);

  if (!groups) {
    return false;
  }

  /**
   * IPv6 loopback:
   *
   * ::1
   */
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  ) {
    return true;
  }

  /**
   * IPv6 unspecified:
   *
   * ::
   */
  if (groups.every((group) => group === 0)) {
    return true;
  }

  /**
   * IPv4-mapped IPv6:
   *
   * ::ffff:127.0.0.1
   * ::ffff:7f00:1
   *
   * Both representations describe the same address.
   *
   * The important part is that we inspect the canonical
   * hexadecimal representation rather than relying on the
   * textual dotted-decimal representation.
   */
  const isIPv4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;

  if (isIPv4Mapped) {
    const firstOctet = groups[6] >> 8;
    const secondOctet = groups[6] & 0xff;
    const thirdOctet = groups[7] >> 8;
    const fourthOctet = groups[7] & 0xff;

    const mappedIPv4 = `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`;

    return isPrivateIPv4(mappedIPv4);
  }

  /**
   * IPv4-compatible / IPv4-embedded forms.
   *
   * These are included for completeness so an IPv4 address
   * embedded in an IPv6 representation cannot bypass the
   * IPv4 private-network checks.
   */
  const isIPv4Compatible =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;

  if (isIPv4Compatible) {
    const firstOctet = groups[6] >> 8;
    const secondOctet = groups[6] & 0xff;
    const thirdOctet = groups[7] >> 8;
    const fourthOctet = groups[7] & 0xff;

    const embeddedIPv4 = `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`;

    if (isPrivateIPv4(embeddedIPv4)) {
      return true;
    }
  }

  /**
   * fc00::/7 - Unique Local Addresses.
   */
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }

  /**
   * fe80::/10 - link-local.
   */
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true;
  }

  /**
   * ff00::/8 - multicast.
   */
  if ((groups[0] & 0xff00) === 0xff00) {
    return true;
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
 * Validate that the article URL can be fetched directly without
 * requiring the scraper to follow an HTTP redirect.
 *
 * IMPORTANT SECURITY PROPERTY:
 *
 * scrapeArticle() accepts only a URL and controls its own HTTP
 * redirect behavior. Therefore this function deliberately rejects
 * redirect responses instead of manually validating a redirect
 * chain and then passing the original URL to a scraper that may
 * independently follow the chain.
 *
 * This keeps the validation policy aligned with the actual URL
 * that scrapeArticle receives.
 */
async function validateUrlRedirectChain(rawUrl: string): Promise<void> {
  if (!isSafeUrl(rawUrl)) {
    throw new Error(`Unsafe article URL: ${rawUrl}`);
  }

  const parsed = new URL(rawUrl);

  await resolveAndValidateHostname(parsed.hostname);

  let response: Response;

  try {
    response = await withTimeout(
      fetch(rawUrl, {
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
        fetch(rawUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            Range: "bytes=0-0",
            "User-Agent": "Eaglespress/1.0 (+https://eaglespress.com",
          },
        }),
        SCRAPE_TIMEOUT_MS,
      );
    } catch (getError) {
      throw new TransientUrlValidationError(
        `Transient URL validation probe failure: ${rawUrl}`,
        { cause: getError ?? headError },
      );
    }
  }

  /**
   * Any 3xx response is deliberately rejected.
   *
   * We do not manually follow the redirect here because
   * scrapeArticle() may follow redirects independently. Following
   * them in this validator would therefore create a mismatch
   * between the URL security decision and the actual request path.
   */
  if (response.status >= 300 && response.status < 400) {
    const redirectUrl = getRedirectUrl(rawUrl, response);

    if (redirectUrl) {
      throw new Error(
        `Redirecting article URL rejected: ${rawUrl} -> ${redirectUrl}`,
      );
    }

    throw new Error(
      `Redirecting article URL missing Location header: ${rawUrl}`,
    );
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
    // STEP 1: FETCH + DEDUPLICATE EACH RSS FEED
    //
    // IMPORTANT:
    //
    // The previous implementation fetched every feed in one
    // durable step and returned one potentially very large
    // RawArticle[] payload. It then returned another large
    // RawArticle[] from the deduplication step.
    //
    // Each feed is now an independent durable step. A single
    // step can return at most MAX_ITEMS_PER_FEED (20) articles,
    // so no durable step contains the entire RSS collection.
    //
    // FEED_CONCURRENCY still controls how many feed steps are
    // scheduled concurrently.
    //
    // Redis + Postgres dedupe is performed in the same durable
    // step as the feed fetch so we do not persist a second large
    // RawArticle[] result.
    // ───────────────────────────────────────────────────────

    const feedLimit = pLimit(FEED_CONCURRENCY);

    const feedResults = await Promise.all(
      (FEEDS as readonly Feed[]).map((feed: Feed, feedIndex: number) =>
        feedLimit(async (): Promise<RawArticle[]> => {
          return step.run(
            `fetch-and-dedupe-feed-${feedIndex}`,
            async (): Promise<RawArticle[]> => {
              let items: Parser.Item[];

              try {
                items = (await RSS_PARSER.parseURL(feed.url)).items;
              } catch (error) {
                logger.warn(`Feed failed: ${feed.url}`, error);

                return [];
              }

              const articles = items
                .slice(0, MAX_ITEMS_PER_FEED)
                .map((item) => parseRssItem(item, feed.url))
                .filter((article): article is RawArticle => article !== null);

              if (!articles.length) {
                return [];
              }

              // Memory dedupe is now scoped to this feed. Cross-feed
              // duplicates are handled by Redis/Postgres below.
              const memorySeen = new Set<string>();

              const memoryDeduped = articles.filter((article: RawArticle) => {
                if (memorySeen.has(article.url)) {
                  return false;
                }

                memorySeen.add(article.url);

                return true;
              });

              if (!memoryDeduped.length) {
                return [];
              }

              const urls = memoryDeduped.map(
                (article: RawArticle) => article.url,
              );

              const keys = urls.map(getDedupeKey);

              const redisResults = await safeRedis(
                (redis) => redis.mGet(keys),
                new Array<string | null>(keys.length).fill(null),
              );

              const seen = new Set<string>();

              redisResults.forEach((value, index) => {
                const url = urls[index];

                if (value !== null && url !== undefined) {
                  seen.add(url);
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
        }),
      ),
    );

    let totalProcessed = 0;
    let totalSaved = 0;
    let totalFailed = 0;

    // ───────────────────────────────────────────────────────
    // PROCESS EACH FEED'S SMALL RESULT IN DURABLE BATCHES
    //
    // IMPORTANT:
    //
    // uniqueArticles is intentionally NOT built for the entire
    // function run. Each feed result contains at most
    // MAX_ITEMS_PER_FEED articles and is processed before moving
    // to the next feed result.
    //
    // Full scraped article content stays entirely inside each
    // process-articles-N step.
    //
    // The process step returns ONLY:
    //
    //   processed
    //   savedPostIds
    //   failed
    //
    // Therefore article bodies and AI content never become
    // Inngest step output.
    // ───────────────────────────────────────────────────────

    /**
     * Run-scoped URL deduplication.
     *
     * Each feed performs its own Redis/Postgres dedupe before the
     * feed results are returned. Because all feed steps complete
     * before this processing loop starts, the same normalized URL
     * can still legitimately appear in results from multiple feeds.
     *
     * `posts.url` is not protected by a database uniqueness
     * constraint, so this in-memory set is required to guarantee
     * that one fetch-news run cannot save the same article URL more
     * than once, even when it appears in multiple RSS feeds.
     */
    const runScopedUrlSeen = new Set<string>();

    for (let feedIndex = 0; feedIndex < feedResults.length; feedIndex += 1) {
      const feedArticles = feedResults[feedIndex];

      if (!feedArticles || !feedArticles.length) {
        continue;
      }

      const uniqueArticles: RawArticle[] = [];

      for (const article of feedArticles) {
        if (runScopedUrlSeen.has(article.url)) {
          continue;
        }

        runScopedUrlSeen.add(article.url);
        uniqueArticles.push(article);
      }

      if (!uniqueArticles.length) {
        continue;
      }

      for (
        let start = 0, batchIndex = 0;
        start < uniqueArticles.length;
        start += PROCESS_BATCH_SIZE, batchIndex += 1
      ) {
        const batch = uniqueArticles.slice(start, start + PROCESS_BATCH_SIZE);

        const processResult = await step.run(
          `process-articles-${feedIndex}-${batchIndex}`,
          async (): Promise<ProcessBatchResult> => {
            /**
             * IMPORTANT:
             *
             * processed is the original chunk size.
             *
             * This preserves the existing behavior where rejected
             * scrapes and content-quality drops are reflected in the
             * aggregate counters.
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

            aiResults.forEach((result, aiBatchIndex) => {
              const aiBatch = aiBatches[aiBatchIndex];

              if (!aiBatch) {
                return;
              }

              for (
                let articleIndex = 0;
                articleIndex < aiBatch.length;
                articleIndex += 1
              ) {
                const article = aiBatch[articleIndex];

                if (!article) {
                  continue;
                }

                const summary =
                  result.status === "fulfilled"
                    ? (result.value.summaries[articleIndex]?.summary ?? null)
                    : null;

                enrichedArticles.push({
                  article,
                  summary: summary?.trim() ?? null,
                });
              }
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

                    detectCategoryId(
                      `${article.title} ${article.content ?? ""}`,
                    ),
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
                    logger.warn(
                      `Failed to save article: ${article.url}`,
                      error,
                    );

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

          for (
            let start = 0, eventBatchIndex = 0;
            start < postIds.length;
            start += EVENT_BATCH_SIZE, eventBatchIndex += 1
          ) {
            const eventPostIds = postIds.slice(start, start + EVENT_BATCH_SIZE);

            /**
             * Load the saved posts inside one durable step.
             *
             * The result is deliberately bounded to EVENT_BATCH_SIZE.
             */
            const savedPosts = await step.run(
              `get-event-posts-${feedIndex}-${batchIndex}-${eventBatchIndex}`,
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
              `send-article-created-${feedIndex}-${batchIndex}-${eventBatchIndex}`,
              events,
            );

            // ─────────────────────────────────────────────
            // REDIS DEDUPE FOR THIS SAME BATCH
            // ─────────────────────────────────────────────

            await step.run(
              `mark-redis-${feedIndex}-${batchIndex}-${eventBatchIndex}`,
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
