import Parser from "rss-parser";
import pLimit from "p-limit";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { cron } from "inngest";
import { inngest } from "../lib/inngest";
import { db } from "../db";
import { posts } from "../db/schema";
import { getRedis } from "../lib/redis";
import type { InngestFunction } from "inngest";
import { FEEDS, getOrCreateSource } from "./source";
import { scrapeArticle } from "./scraper";
import { batchSummarize } from "./ai";
import { generateSlug, ensureUniqueSlug } from "../utils/slug";
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
  return isNaN(d.getTime()) ? null : d.toISOString(); // ✅ KEY CHANGE
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
  link: z.string().url(),
  contentSnippet: z.string().optional(),
  enclosure: z.object({ url: z.string().url() }).optional(),
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
    triggers: [cron("0 */12 * * *")],
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

    // ── STEP 2: Deduplication ───────────────────────────────────────────

    const uniqueArticles: RawArticle[] = await step.run(
      "deduplicate",
      async () => {
        const multi = redis.multi();

        rawArticles.forEach((a) => {
          multi.set(getDedupeKey(a.url), "1", {
            NX: true,
            EX: DEDUPE_TTL_SECONDS,
          });
        });

        const multiResults = await multi.exec();

        const redisNew = rawArticles.filter((_, i) => {
          const r = multiResults?.[i];

          if (r == null) return false;

          if (Array.isArray(r)) {
            const [err, value] = r;

            if (err) {
              // optionally log this
              return false;
            }

            if (typeof value === "string") return value === "OK";
            if (typeof value === "number") return value === 1;

            return false;
          }

          if (typeof r === "string") return r === "OK";
          if (typeof r === "number") return r === 1;

          return false;
        });

        if (!redisNew.length) return [];

        // chunk DB query
        const urls = redisNew.map((a) => a.url);
        const existingSet = new Set<string>();

        const chunkSize = 100;
        for (let i = 0; i < urls.length; i += chunkSize) {
          const chunk = urls.slice(i, i + chunkSize);
          const rows = await db
            .select({ url: posts.url })
            .from(posts)
            .where(inArray(posts.url, chunk));

          rows.forEach((r) => existingSet.add(r.url));
        }

        const fresh = redisNew.filter((a) => !existingSet.has(a.url));

        logger.info(
          `Dedupe: ${rawArticles.length} → ${redisNew.length} → ${fresh.length}`,
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

        const failed = results.filter((r) => r.status === "rejected");

        failed.forEach((f) => logger.warn("Scrape failed:", (f as any).reason));

        logger.info(`Scraped ${success.length} articles`);
        return success;
      },
    );

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
          batches.map((b) => limit(() => batchSummarize(b))),
        );

        const summaries = results
          .filter(
            (r): r is PromiseFulfilledResult<any[]> => r.status === "fulfilled",
          )
          .flatMap((r) => r.value);

        if (summaries.length !== scrapedArticles.length) {
          logger.warn("Summary mismatch — using fallbacks");
        }

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

    // ── STEP 5: Save ────────────────────────────────────────────────────

    const saveResults = await step.run("save-to-database", async () => {
      const limit = pLimit(SAVE_CONCURRENCY);

      const results = await Promise.allSettled(
        enrichedArticles.map((article) =>
          limit(async () => {
            const [slug, source, categoryId] = await Promise.all([
              ensureUniqueSlug(generateSlug(article.title)),
              getOrCreateSource(article.feedUrl),
              detectCategoryId(`${article.title} ${article.content}`),
            ]);

            const score = calculatePostScore({
              title: article.title,
              content: article.content,
              hasImage: !!article.imageUrl,
              // createdAt: article.createdAt,
              createdAt: article.createdAt ? new Date(article.createdAt) : null,
            });

            await db
              .insert(posts)
              .values({
                title: article.title,
                slug,
                description: article.summary,
                url: article.url,
                imageUrl: article.imageUrl,
                sourceId: source.id,
                categoryId,
                score,
                // createdAt: article.createdAt ?? new Date(),
                createdAt: article.createdAt
                  ? new Date(article.createdAt)
                  : new Date(),
              })
              .onConflictDoNothing({ target: posts.url });

            return article.url;
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected");

      failed.forEach((f) => logger.error("Insert failed:", (f as any).reason));

      return { succeeded, failed: failed.length };
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
