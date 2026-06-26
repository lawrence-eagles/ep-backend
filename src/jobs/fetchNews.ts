import Parser from "rss-parser";
import pLimit from "p-limit";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { inngest } from "../lib/inngest";
import { db } from "../db";
import { posts } from "../db/schema";
import { getRedis } from "../lib/redis";
import type { InngestFunction } from "inngest";
import { FEEDS, getOrCreateSource } from "./source";
import { scrapeArticle } from "./scraper";
import { batchSummarize } from "./ai";
import { insertPostWithUniqueSlug } from "../utils/slug";
import { detectCategoryId } from "./category";
import { calculatePostScore } from "./score";

import type { RawArticle, ScrapedArticle, EnrichedArticle } from "./types";

// ── Config ─────────────────────────────────────────

const RSS_PARSER = new Parser({ timeout: 10_000 });
const FEED_CONCURRENCY = 5;
const SCRAPE_CONCURRENCY = 5;
const AI_BATCH_SIZE = 5;
const SAVE_CONCURRENCY = 10;
const DEDUPE_TTL_SECONDS = 86_400;
const MAX_ITEMS_PER_FEED = 20;
const MIN_CONTENT_LENGTH = 200;

// ── Helpers ────────────────────────────────────────

function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return false;

    const hostname = url.hostname;
    if (hostname === "localhost") return false;

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

function normalizeUrl(url: string) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

const getDedupeKey = (url: string) => `seen:article:${normalizeUrl(url)}`;

function safeDate(input?: string | null): string | null {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    ),
  ]);
}

// ── SAFE REDIS HELPERS ────────────────────────────

async function safeRedis<T>(
  fn: (redis: Awaited<ReturnType<typeof getRedis>>) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    const redis = await getRedis();
    return await withTimeout(fn(redis), 2000);
  } catch {
    return fallback;
  }
}

async function safeCacheInvalidate(
  fn: (redis: Awaited<ReturnType<typeof getRedis>>) => Promise<void>,
) {
  try {
    const redis = await getRedis();
    await fn(redis);
  } catch (err) {
    console.error("REDIS ERROR (non-blocking):", err);
  }
}

// ── Content Quality ───────────────────────────────

function isValidContent(content: string | null): boolean {
  if (!content) return false;

  const cleaned = content.replace(/\s+/g, " ").trim();

  if (cleaned.length < MIN_CONTENT_LENGTH) return false;

  const junkPatterns = [
    /please enable javascript to view this page/i,
    /you need to enable javascript to view this page/i,
    /enable javascript to view this page/i,
  ];

  if (junkPatterns.some((r) => r.test(cleaned))) return false;

  return cleaned.split(". ").length >= 3;
}

// ── Zod Schema ───────────────────────────────────

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
  if (!parsed.success) return null;

  const { title, link, contentSnippet, enclosure, pubDate } = parsed.data;

  return {
    title: title.trim(),
    url: normalizeUrl(link),
    description: contentSnippet ?? "",
    imageUrl: enclosure?.url ?? null,
    feedUrl,
    createdAt: safeDate(pubDate),
  };
}

// ── MAIN FUNCTION ────────────────────────────────

export const fetchNews: InngestFunction.Any = inngest.createFunction(
  {
    id: "fetch-news-production",
    name: "Fetch News from RSS Feeds",
    concurrency: { limit: 1 },
    triggers: { cron: "0 */6 * * *" },
    retries: 2,
  },

  async ({ step, logger }) => {
    // ── STEP 1: FETCH RSS ───────────────────────

    const rawArticles = await step.run("fetch-rss-feeds", async () => {
      const results: RawArticle[] = [];
      const limit = pLimit(FEED_CONCURRENCY);

      const feedResults = await Promise.allSettled(
        FEEDS.map((feed) =>
          limit(async () => {
            const parsed = await RSS_PARSER.parseURL(feed.url);
            return parsed.items
              .slice(0, MAX_ITEMS_PER_FEED)
              .map((item) => parseRssItem(item, feed.url))
              .filter((a): a is RawArticle => a !== null);
          }),
        ),
      );

      feedResults.forEach((result, i) => {
        if (result.status === "fulfilled") {
          results.push(...result.value);
        } else {
          logger.warn(`Feed failed: ${FEEDS[i].url}`, result.reason);
        }
      });

      return results;
    });

    if (!rawArticles.length) return { processed: 0 };

    // ── MEMORY DEDUPE ───────────────────────────

    const memorySeen = new Set<string>();
    const memoryDeduped = rawArticles.filter((a) => {
      if (memorySeen.has(a.url)) return false;
      memorySeen.add(a.url);
      return true;
    });

    // ── STEP 2: REDIS + DB DEDUPE ───────────────

    const uniqueArticles: RawArticle[] = await step.run(
      "deduplicate",
      async () => {
        const urls = memoryDeduped.map((a) => a.url);
        const keys = urls.map(getDedupeKey);

        const redisResults = await safeRedis(
          (redis) => redis.mGet(keys),
          new Array(keys.length).fill(null),
        );

        const seen = new Set<string>();
        redisResults.forEach((val, i) => {
          if (val !== null) seen.add(urls[i]);
        });

        const notSeen = memoryDeduped.filter((a) => !seen.has(a.url));

        const existingSet = new Set<string>();

        for (let i = 0; i < notSeen.length; i += 100) {
          const chunk = notSeen.slice(i, i + 100).map((a) => a.url);

          const rows = await db
            .select({ url: posts.url })
            .from(posts)
            .where(inArray(posts.url, chunk));

          rows.forEach((r) => existingSet.add(r.url));
        }

        return notSeen.filter((a) => !existingSet.has(a.url));
      },
    );

    if (!uniqueArticles.length) return { processed: 0 };

    // ── STEP 3: SCRAPE ──────────────────────────

    const scrapedArticles: ScrapedArticle[] = await step.run(
      "scrape-content",
      async () => {
        const limit = pLimit(SCRAPE_CONCURRENCY);

        const results = await Promise.allSettled(
          uniqueArticles.map((article) =>
            limit(async (): Promise<ScrapedArticle> => {
              const scraped = await withTimeout(
                scrapeArticle(article.url),
                10000,
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
            }),
          ),
        );

        return results
          .filter(
            (r): r is PromiseFulfilledResult<ScrapedArticle> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value);
      },
    );

    if (!scrapedArticles.length) return { processed: 0 };

    // ── STEP 4: AI ──────────────────────────────

    const enrichedArticles: EnrichedArticle[] = await step.run(
      "ai-summarize",
      async () => {
        const validArticles = scrapedArticles.filter((a) =>
          isValidContent(a.content),
        );

        if (!validArticles.length) return [];

        const batches: string[][] = [];

        for (let i = 0; i < validArticles.length; i += AI_BATCH_SIZE) {
          batches.push(
            validArticles
              .slice(i, i + AI_BATCH_SIZE)
              .map((a) => a.content as string),
          );
        }

        const limit = pLimit(3);

        const results = await Promise.allSettled(
          batches.map((batch) =>
            limit(async () => ({
              summaries: await batchSummarize(batch),
            })),
          ),
        );

        const enriched: EnrichedArticle[] = [];

        results.forEach((r, batchIdx) => {
          const batchArticles = validArticles.slice(
            batchIdx * AI_BATCH_SIZE,
            batchIdx * AI_BATCH_SIZE + AI_BATCH_SIZE,
          );

          batchArticles.forEach((article, j) => {
            const summary =
              r.status === "fulfilled"
                ? (r.value.summaries[j]?.summary ?? null)
                : null;

            enriched.push({ ...article, summary });
          });
        });

        return enriched;
      },
    );

    if (!enrichedArticles.length) return { processed: 0 };

    // ── STEP 5: SAVE ────────────────────────────

    const saveResults = await step.run("save", async () => {
      const limit = pLimit(SAVE_CONCURRENCY);

      const results = await Promise.allSettled(
        enrichedArticles.map((article) =>
          limit(async () => {
            if (!article.summary) return null;

            const [source, categoryId] = await Promise.all([
              getOrCreateSource(article.feedUrl),
              detectCategoryId(`${article.title} ${article.content ?? ""}`),
            ]);

            const score = calculatePostScore({
              title: article.title,
              content: article.content ?? "",
              hasImage: !!article.imageUrl,
              createdAt: article.createdAt ? new Date(article.createdAt) : null,
            });

            const inserted = await insertPostWithUniqueSlug({
              title: article.title,
              description: article.summary,
              url: article.url,
              imageUrl: article.imageUrl,
              sourceId: source.id,
              categoryId,
              score,
              createdAt: article.createdAt
                ? new Date(article.createdAt)
                : new Date(),
            }).catch(() => null);

            if (!inserted) return null;

            // ✅ FIXED: return type now Promise<void> + non-blocking
            safeCacheInvalidate(async (redis) => {
              await redis.set(getDedupeKey(article.url), "1", {
                EX: DEDUPE_TTL_SECONDS,
              });
            });

            return article.url;
          }),
        ),
      );

      const succeeded = results.filter(
        (r) => r.status === "fulfilled" && r.value !== null,
      ).length;

      return {
        succeeded,
        failed: results.length - succeeded,
      };
    });

    return {
      processed: enrichedArticles.length,
      saved: saveResults.succeeded,
      failed: saveResults.failed,
    };
  },
);
