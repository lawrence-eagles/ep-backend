import Parser from "rss-parser";
import pLimit from "p-limit";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { inngest } from "../../lib/inngest";
import { db } from "../../db";
import { posts } from "../../db/schema";
import { getRedis } from "../../lib/redis";
import type { InngestFunction } from "inngest";
import { FEEDS, getOrCreateSource } from "../source";
import { scrapeArticle } from "../scraper";
import { batchSummarize } from "../ai";
import { insertPostWithUniqueSlug } from "../../utils/slug";
import { detectCategoryId } from "../category";
import { calculatePostScore } from "../score";

import type { RawArticle } from "../types";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const RSS_PARSER = new Parser({
  timeout: 10_000,
});

const FEED_CONCURRENCY = 5;
const SCRAPE_CONCURRENCY = 5;
const AI_BATCH_SIZE = 5;
const AI_BATCH_CONCURRENCY = 3;
const SAVE_CONCURRENCY = 10;

/**
 * Number of articles processed inside one durable Inngest step.
 *
 * This is intentionally larger than AI_BATCH_SIZE because AI
 * still processes content in groups of 5 inside this step.
 *
 * Example:
 *
 * 25 articles
 *   ├── AI batch 1 → 5
 *   ├── AI batch 2 → 5
 *   ├── AI batch 3 → 5
 *   ├── AI batch 4 → 5
 *   └── AI batch 5 → 5
 */
const PROCESS_BATCH_SIZE = 25;

/**
 * Maximum number of articles returned by one dedupe step.
 */
const DEDUPE_BATCH_SIZE = 100;

/**
 * Number of Inngest steps allowed to be discovered/executed
 * concurrently by this function.
 *
 * Free Inngest plans currently allow up to 5 concurrent steps.
 */
const STEP_CONCURRENCY = 5;

const DEDUPE_TTL_SECONDS = 86_400;
const MAX_ITEMS_PER_FEED = 20;
const MIN_CONTENT_LENGTH = 200;

const ARTICLE_SCRAPE_TIMEOUT_MS = 10_000;
const REDIS_TIMEOUT_MS = 2_000;

/**
 * RSS feeds occasionally return extremely large descriptions.
 *
 * The description is only used as a fallback when scraping fails,
 * so there is no reason to carry an unlimited RSS description
 * through Inngest state.
 */
const MAX_RSS_DESCRIPTION_LENGTH = 4_000;

/**
 * Notification payloads must remain small.
 *
 * This is intentionally far below Inngest's event payload limits.
 */
const MAX_EVENT_TITLE_LENGTH = 500;
const MAX_EVENT_SUMMARY_LENGTH = 6_000;

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type ScrapedArticle = RawArticle & {
  content: string | null;
  imageUrl: string | null;
};

type SavedArticleEvent = {
  postId: string;
  categoryId: string;
  title: string;
  summary: string;
  slug: string;
  url: string;
};

type ProcessBatchResult = {
  processed: number;
  saved: number;
  failed: number;
  notifications: SavedArticleEvent[];
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);

    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }

    const hostname = url.hostname.toLowerCase();

    if (hostname === "localhost") {
      return false;
    }

    if (hostname.endsWith(".localhost")) {
      return false;
    }

    const ipv4 = hostname.match(/^(?:\d{1,3}\.){3}\d{1,3}$/);

    if (ipv4) {
      const [a, b] = hostname.split(".").map(Number);

      if (a === 127) return false;
      if (a === 10) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);

    u.search = "";
    u.hash = "";

    return u.toString();
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

  return isNaN(date.getTime()) ? null : date.toISOString();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}…`;
}

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

/**
 * Run Inngest steps in controlled groups.
 *
 * This prevents a large feed/article count from creating hundreds
 * of simultaneous step requests.
 */
async function runStepBatches<T>(
  items: T[],
  batchSize: number,
  run: (item: T, index: number) => Promise<T extends never ? never : any>,
): Promise<any[]> {
  const results: any[] = [];

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);

    const batchResults = await Promise.all(
      batch.map((item, offset) => run(item, start + offset)),
    );

    results.push(...batchResults);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// REDIS
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

async function safeCacheSet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    const redis = await getRedis();

    await withTimeout(
      redis.set(key, value, {
        EX: ttlSeconds,
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
// RSS VALIDATION
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
// SCRAPING
// ─────────────────────────────────────────────────────────────

async function scrapeOneArticle(article: RawArticle): Promise<ScrapedArticle> {
  try {
    const scraped = await withTimeout(
      scrapeArticle(article.url),
      ARTICLE_SCRAPE_TIMEOUT_MS,
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
     * Scraping failures do not abort the entire batch.
     *
     * This preserves the Promise.allSettled behavior from the
     * original implementation.
     */
    return {
      ...article,
      content: isValidContent(article.description) ? article.description : null,
      imageUrl: article.imageUrl,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN FUNCTION
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
    // STEP 1
    // FETCH RSS FEEDS
    //
    // IMPORTANT:
    //
    // Each feed has its own Inngest step.
    //
    // We deliberately do NOT have one step return the entire
    // RSS collection.
    // ───────────────────────────────────────────────────────

    const feedResults = await runStepBatches(
      FEEDS,
      STEP_CONCURRENCY,
      async (feed, feedIndex) =>
        step.run(
          `fetch-rss-feed-${feedIndex}`,
          async (): Promise<RawArticle[]> => {
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
          },
        ),
    );

    const rawArticles: RawArticle[] = feedResults.flat();

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

    const memoryDeduped = rawArticles.filter((article) => {
      if (memorySeen.has(article.url)) {
        return false;
      }

      memorySeen.add(article.url);

      return true;
    });

    // ───────────────────────────────────────────────────────
    // STEP 2
    // REDIS + DATABASE DEDUPE
    // ───────────────────────────────────────────────────────

    const dedupeChunks: RawArticle[][] = [];

    for (let i = 0; i < memoryDeduped.length; i += DEDUPE_BATCH_SIZE) {
      dedupeChunks.push(memoryDeduped.slice(i, i + DEDUPE_BATCH_SIZE));
    }

    const uniqueChunkResults = await runStepBatches(
      dedupeChunks,
      STEP_CONCURRENCY,
      async (chunk, chunkIndex) =>
        step.run(
          `deduplicate-${chunkIndex}`,
          async (): Promise<RawArticle[]> => {
            const urls = chunk.map((article) => article.url);

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

            const notSeen = chunk.filter((article) => !seen.has(article.url));

            if (!notSeen.length) {
              return [];
            }

            const existingSet = new Set<string>();

            const dbUrls = notSeen.map((article) => article.url);

            for (let i = 0; i < dbUrls.length; i += DEDUPE_BATCH_SIZE) {
              const dbChunk = dbUrls.slice(i, i + DEDUPE_BATCH_SIZE);

              const rows = await db
                .select({
                  url: posts.url,
                })
                .from(posts)
                .where(inArray(posts.url, dbChunk));

              rows.forEach((row) => {
                existingSet.add(row.url);
              });
            }

            return notSeen.filter((article) => !existingSet.has(article.url));
          },
        ),
    );

    const uniqueArticles = uniqueChunkResults.flat();

    if (!uniqueArticles.length) {
      return {
        processed: 0,
        saved: 0,
        failed: 0,
      };
    }

    // ───────────────────────────────────────────────────────
    // STEP 3–5
    // SCRAPE → AI → SAVE
    //
    // THIS IS THE CORE PAYLOAD FIX.
    //
    // Full article content exists only inside these steps.
    //
    // It is NEVER returned by step.run().
    // ───────────────────────────────────────────────────────

    const processChunks: RawArticle[][] = [];

    for (let i = 0; i < uniqueArticles.length; i += PROCESS_BATCH_SIZE) {
      processChunks.push(uniqueArticles.slice(i, i + PROCESS_BATCH_SIZE));
    }

    const processResults = await runStepBatches(
      processChunks,
      STEP_CONCURRENCY,
      async (chunk, chunkIndex) =>
        step.run(
          `process-articles-${chunkIndex}`,
          async (): Promise<ProcessBatchResult> => {
            // ─────────────────────────────────────────
            // SCRAPE
            // ─────────────────────────────────────────

            const scrapeLimit = pLimit(SCRAPE_CONCURRENCY);

            const scrapedResults = await Promise.allSettled(
              chunk.map((article) =>
                scrapeLimit(() => scrapeOneArticle(article)),
              ),
            );

            const scrapedArticles = scrapedResults
              .filter(
                (result): result is PromiseFulfilledResult<ScrapedArticle> =>
                  result.status === "fulfilled",
              )
              .map((result) => result.value);

            if (!scrapedArticles.length) {
              return {
                processed: 0,
                saved: 0,
                failed: 0,
                notifications: [],
              };
            }

            // ─────────────────────────────────────────
            // AI SUMMARIZATION
            // ─────────────────────────────────────────

            const validArticles = scrapedArticles.filter((article) =>
              isValidContent(article.content),
            );

            if (!validArticles.length) {
              return {
                processed: 0,
                saved: 0,
                failed: 0,
                notifications: [],
              };
            }

            const aiBatches: ScrapedArticle[][] = [];

            for (let i = 0; i < validArticles.length; i += AI_BATCH_SIZE) {
              aiBatches.push(validArticles.slice(i, i + AI_BATCH_SIZE));
            }

            const aiLimit = pLimit(AI_BATCH_CONCURRENCY);

            const aiResults = await Promise.all(
              aiBatches.map((articles) =>
                aiLimit(async () => {
                  try {
                    const summaries = await batchSummarize(
                      articles.map((article) => article.content as string),
                    );

                    return {
                      articles,
                      summaries,
                    };
                  } catch (error) {
                    logger.warn(
                      `AI batch failed for ${articles.length} articles`,
                      error,
                    );

                    return {
                      articles,
                      summaries: [],
                    };
                  }
                }),
              ),
            );

            const enrichedArticles = aiResults.flatMap(
              ({ articles, summaries }) =>
                articles.map((article, index) => ({
                  article,
                  summary: summaries[index]?.summary?.trim() ?? null,
                })),
            );

            /**
             * This matches the original function:
             *
             * - articles with no AI summary reach the save stage
             * - they are not saved
             * - they count as failed
             */
            const processed = enrichedArticles.length;

            if (!processed) {
              return {
                processed: 0,
                saved: 0,
                failed: 0,
                notifications: [],
              };
            }

            // ─────────────────────────────────────────
            // SAVE
            // ─────────────────────────────────────────

            const saveLimit = pLimit(SAVE_CONCURRENCY);

            const saveResults = await Promise.allSettled(
              enrichedArticles.map(({ article, summary }) =>
                saveLimit(async (): Promise<SavedArticleEvent | null> => {
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
                  }).catch(() => null);

                  if (!inserted) {
                    return null;
                  }

                  /**
                   * IMPORTANT:
                   *
                   * Do NOT call inngest.send() here.
                   *
                   * We return only small notification
                   * metadata. The parent function will
                   * send the events using step.sendEvent().
                   *
                   * Full article content is NOT included.
                   */
                  return {
                    postId: inserted.id,

                    categoryId,

                    title: truncateText(article.title, MAX_EVENT_TITLE_LENGTH),

                    summary: truncateText(summary, MAX_EVENT_SUMMARY_LENGTH),

                    slug: inserted.slug,

                    url: article.url,
                  };
                }),
              ),
            );

            const notifications: SavedArticleEvent[] = [];

            saveResults.forEach((result) => {
              if (result.status === "fulfilled" && result.value) {
                notifications.push(result.value);
              }

              if (result.status === "rejected") {
                logger.warn("Article save failed", result.reason);
              }
            });

            const saved = notifications.length;

            const failed = processed - saved;

            return {
              processed,
              saved,
              failed,
              notifications,
            };
          },
        ),
    );

    // ───────────────────────────────────────────────────────
    // STEP 6
    // ARTICLE.CREATED EVENTS
    //
    // step.sendEvent() is durable and prevents duplicate
    // event delivery when the function is replayed/retried.
    // ───────────────────────────────────────────────────────

    const notificationBatches = processResults
      .map((result) => result.notifications)
      .filter((notifications) => notifications.length > 0);

    await runStepBatches(
      notificationBatches,
      STEP_CONCURRENCY,
      async (notifications, batchIndex) =>
        step.sendEvent(
          `article-created-events-${batchIndex}`,
          notifications.map((article) => ({
            /**
             * Deterministic event ID.
             *
             * If the same event is accidentally submitted
             * again, Inngest will deduplicate it.
             */
            id: `article-created-${article.postId}`,

            name: "article.created",

            data: {
              postId: article.postId,

              categoryId: article.categoryId,

              title: article.title,

              summary: article.summary,

              slug: article.slug,
            },
          })),
        ),
    );

    // ───────────────────────────────────────────────────────
    // STEP 7
    // REDIS DEDUPE MARKERS
    //
    // Redis is updated only after article.created events have
    // successfully been handed to Inngest.
    //
    // One Redis step handles an entire process batch instead
    // of creating one Inngest step per article.
    // ───────────────────────────────────────────────────────

    const redisChunks: SavedArticleEvent[][] = processResults
      .map((result) => result.notifications)
      .filter((notifications) => notifications.length > 0);

    await runStepBatches(
      redisChunks,
      STEP_CONCURRENCY,
      async (notifications, batchIndex) =>
        step.run(`mark-redis-${batchIndex}`, async () => {
          await Promise.all(
            notifications.map((article) =>
              safeCacheSet(getDedupeKey(article.url), "1", DEDUPE_TTL_SECONDS),
            ),
          );

          return {
            marked: notifications.length,
          };
        }),
    );

    // ───────────────────────────────────────────────────────
    // FINAL RESULT
    //
    // Only tiny counters are returned from the function.
    // ───────────────────────────────────────────────────────

    return processResults.reduce(
      (totals, result) => ({
        processed: totals.processed + result.processed,

        saved: totals.saved + result.saved,

        failed: totals.failed + result.failed,
      }),
      {
        processed: 0,
        saved: 0,
        failed: 0,
      },
    );
  },
);
