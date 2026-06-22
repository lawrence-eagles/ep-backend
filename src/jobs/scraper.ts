import * as cheerio from "cheerio";
import crypto from "crypto";
import { redis } from "../lib/redis";

// ── Cache / lock key builders ──────────────────────────────────────────────────

function hashUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

const getCacheKey = (url: string) => {
  const hashed = hashUrl(url);
  return `article:content:${hashed}`;
};

const getLockKey = (url: string) => {
  const hashed = hashUrl(url);
  return `article:lock:${hashed}`;
};

// ── Result shape ───────────────────────────────────────────────────────────────

export interface ScrapeResult {
  content: string | null;
  imageUrl: string | null;
}

// ── Extract article content and OG image ──────────────────────────────────────
//
// node-redis migration:
//
//   BEFORE (ioredis):   redis.set(key, val, "NX", "EX", 10)
//   AFTER  (node-redis): redis.set(key, val, { NX: true, EX: 10 })
//
//   BEFORE (ioredis):   redis.set(key, val, "EX", 86400)
//   AFTER  (node-redis): redis.set(key, val, { EX: 86400 })
//
//   redis.get() and redis.del() have identical signatures in both clients.
//
// Bug fixed:
//   Catch block previously swallowed errors silently — zero visibility into
//   which URLs were failing and why. Now logs before returning null.

export async function scrapeArticle(url: string): Promise<ScrapeResult> {
  const cacheKey = getCacheKey(url);
  const lockKey = getLockKey(url);

  // ── Cache hit ──────────────────────────────────────────────────────────────

  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ScrapeResult;
    } catch {
      // Corrupt cache entry — fall through to re-scrape
    }
  }

  // ── Acquire distributed lock ───────────────────────────────────────────────

  const acquired = await redis.set(lockKey, "1", { NX: true, EX: 10 });

  if (!acquired) {
    // Another worker is already scraping this URL.
    // Return null — caller falls back to RSS description field.
    return { content: null, imageUrl: null };
  }

  // ── Fetch and parse ────────────────────────────────────────────────────────

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Eaglespress/1.0)" },
    });

    if (!response.ok) {
      return { content: null, imageUrl: null };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove noise elements before extracting text
    $(
      "script, style, nav, header, footer, aside, .ad, .advertisement, [aria-hidden='true']",
    ).remove();

    // Extract main article content — prefer semantic selectors
    let content = $(
      "article p, [role='main'] p, .article-body p, .post-content p, main p",
    )
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 40)
      .join("\n\n");

    // Fallback: all paragraphs site-wide
    if (!content) {
      content = $("p")
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length > 40)
        .join("\n\n");
    }

    const cleanContent = content.slice(0, 5_000) || null;

    // Extract OG / Twitter card image
    const imageUrl =
      $('meta[property="og:image"]').attr("content") ??
      $('meta[name="twitter:image"]').attr("content") ??
      null;

    const result: ScrapeResult = {
      content: cleanContent,
      imageUrl: imageUrl ?? null,
    };

    // Cache result for 24 hours
    await redis.set(cacheKey, JSON.stringify(result), { EX: 86_400 });

    return result;
  } catch (err) {
    console.error(`[scraper] Failed to scrape ${url}:`, (err as Error).message);
    return { content: null, imageUrl: null };
  } finally {
    // Always release the lock — even if fetch() threw
    await redis.del(lockKey);
  }
}
