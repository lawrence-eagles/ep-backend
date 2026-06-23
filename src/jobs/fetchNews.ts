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

// ── Config ───────────────────────────────────────────────────────────────

const RSS_PARSER = new Parser({ timeout: 10_000 });
const FEED_CONCURRENCY = 5;
const SCRAPE_CONCURRENCY = 5;
const AI_BATCH_SIZE = 5;
const SAVE_CONCURRENCY = 10;
const DEDUPE_TTL_SECONDS = 86_400;
const MAX_ITEMS_PER_FEED = 20;

// ── Helpers ──────────────────────────────────────────────────────────────

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

// ── Zod schema ───────────────────────────────────────────────────────────

const RssItemSchema = z.object({
  title: z.string().min(1),
  link: z.string().refine(isSafeUrl, { message: "Unsafe URL" }),
  contentSnippet: z.string().optional(),
  enclosure: z
    .object({
      url: z.string().refine(isSafeUrl, {
        message: "Unsafe enclosure URL",
      }),
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

// ── Main Inngest function ─────────────────────────────────────────────────

export const fetchNews: InngestFunction.Any = inngest.createFunction(
  {
    id: "fetch-news-production",
    name: "Fetch News from RSS Feeds",
    concurrency: { limit: 1 },
    triggers: { cron: "0 */6 * * *" },
    retries: 2,
  },

  async ({ step, logger }) => {
    const redis = await getRedis();

    // ── STEP 1: Fetch RSS ───────────────────────────────────────────────

    const rawArticles = await step.run("fetch-rss-feeds", async () => {
      const results: RawArticle[] = [];
      const feedLimit = pLimit(FEED_CONCURRENCY);

      const feedResults = await Promise.allSettled(
        FEEDS.map((feed) =>
          feedLimit(async () => {
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

      logger.info(`Fetched ${results.length} articles`);
      return results;
    });

    if (!rawArticles.length) {
      logger.info("No articles fetched");
      return { processed: 0 };
    }

    // ── STEP 2: Deduplication (Redis + DB) ───────────────────────────────

    const uniqueArticles: RawArticle[] = await step.run(
      "deduplicate",
      async () => {
        const urls = rawArticles.map((a) => a.url);
        const redisKeys = urls.map(getDedupeKey);

        const redisResults = await redis.mGet(redisKeys);

        const seenSet = new Set<string>();
        redisResults.forEach((val, i) => {
          if (val !== null) seenSet.add(urls[i]);
        });

        const notSeen = rawArticles.filter((a) => !seenSet.has(a.url));

        const existingSet = new Set<string>();

        const chunkSize = 100;
        for (let i = 0; i < notSeen.length; i += chunkSize) {
          const chunk = notSeen.slice(i, i + chunkSize).map((a) => a.url);

          const rows = await db
            .select({ url: posts.url })
            .from(posts)
            .where(inArray(posts.url, chunk));

          rows.forEach((r) => existingSet.add(r.url));
        }

        const fresh = notSeen.filter((a) => !existingSet.has(a.url));

        logger.info(
          `Dedupe: ${rawArticles.length} → ${fresh.length} (redis + db)`,
        );

        return fresh;
      },
    );

    if (!uniqueArticles.length) {
      logger.info("No new articles");
      return { processed: 0 };
    }

    // ── STEP 3: Scraping ────────────────────────────────────────────────

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

              return {
                ...article,
                content:
                  scraped.content ?? article.description ?? article.title,
                imageUrl: scraped.imageUrl ?? article.imageUrl,
              };
            }),
          ),
        );

        const success = results
          .filter(
            (r): r is PromiseFulfilledResult<ScrapedArticle> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value);

        results.forEach((r) => {
          if (r.status === "rejected") {
            logger.warn("Scrape failed:", r.reason);
          }
        });

        logger.info(`Scraped ${success.length} articles`);
        return success;
      },
    );

    if (!scrapedArticles.length) {
      logger.info("No articles scraped");
      return { processed: 0 };
    }

    // ── STEP 4: AI Summarization ────────────────────────────────────────

    const enrichedArticles: EnrichedArticle[] = await step.run(
      "ai-summarize",
      async () => {
        const batches: string[][] = [];

        for (let i = 0; i < scrapedArticles.length; i += AI_BATCH_SIZE) {
          batches.push(
            scrapedArticles.slice(i, i + AI_BATCH_SIZE).map((a) => a.content),
          );
        }

        const limit = pLimit(3);

        const results = await Promise.allSettled(
          batches.map((batch, batchIndex) =>
            limit(async () => ({
              batchIndex,
              summaries: await batchSummarize(batch),
            })),
          ),
        );

        const summaries: Array<{ summary: string } | undefined> = Array(
          scrapedArticles.length,
        ).fill(undefined);

        results.forEach((r) => {
          if (r.status !== "fulfilled") return;

          const start = r.value.batchIndex * AI_BATCH_SIZE;

          r.value.summaries.forEach((s, i) => {
            summaries[start + i] = s;
          });
        });

        return scrapedArticles.map((article, i): EnrichedArticle => {
          const fallback = article.content
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);

          return {
            ...article,
            summary: summaries[i]?.summary ?? fallback,
          };
        });
      },
    );

    // ── STEP 5: Save + Dedupe Commit ────────────────────────────────────

    const saveResults = await step.run("save-to-database", async () => {
      const limit = pLimit(SAVE_CONCURRENCY);

      const results = await Promise.allSettled(
        enrichedArticles.map((article) =>
          limit(async () => {
            const [source, categoryId] = await Promise.all([
              getOrCreateSource(article.feedUrl),
              detectCategoryId(`${article.title} ${article.content}`),
            ]);

            const score = calculatePostScore({
              title: article.title,
              content: article.content,
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

            await redis.set(getDedupeKey(article.url), "1", {
              EX: DEDUPE_TTL_SECONDS,
            });

            return article.url;
          }),
        ),
      );

      const succeeded = results.filter(
        (r) => r.status === "fulfilled" && r.value !== null,
      ).length;

      results.forEach((r) => {
        if (r.status === "rejected") {
          logger.error("Insert failed:", r.reason);
        }
      });

      return {
        succeeded,
        failed: results.length - succeeded,
      };
    });

    // ── STEP 6: Cache Invalidation ──────────────────────────────────────

    if (saveResults.succeeded > 0) {
      await step.run("bump-cache", async () => {
        try {
          const multi = redis.multi();
          multi.incr("feed:global:version");
          multi.incr("feed:trending:version");
          await multi.exec();
        } catch (err) {
          logger.warn("Cache bump failed:", err);
        }
      });
    }

    logger.info(
      `Done: ${saveResults.succeeded} saved, ${saveResults.failed} failed`,
    );

    return {
      processed: enrichedArticles.length,
      saved: saveResults.succeeded,
      failed: saveResults.failed,
    };
  },
);
