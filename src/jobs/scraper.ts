import * as cheerio from "cheerio";
import crypto from "crypto";
import { getRedis } from "../lib/redis";

// ─────────────────────────────────────────────
// 🔒 SAFE REDIS INITIALIZER (FAIL-SAFE)
// ─────────────────────────────────────────────
async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

// ── Cache / lock key builders ───────────────────────────────────────

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

// ── Result shape ────────────────────────────────────────────────────

export interface ScrapeResult {
  content: string | null;
  imageUrl: string | null;
}

// ── Safe unlock script (atomic) ─────────────────────────────────────

const UNLOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

// ── Extract article content and OG image ────────────────────────────

export async function scrapeArticle(url: string): Promise<ScrapeResult> {
  const redis = await getRedisSafe();

  const cacheKey = getCacheKey(url);
  const lockKey = getLockKey(url);

  // ─────────────────────────────────────────
  // 🧠 CACHE READ (OPTIONAL)
  // ─────────────────────────────────────────
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);

      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (
            parsed &&
            (typeof parsed.content === "string" || parsed.content === null) &&
            (typeof parsed.imageUrl === "string" || parsed.imageUrl === null)
          ) {
            return parsed as ScrapeResult;
          }
          console.warn("[scraper] Corrupt cache shape, ignoring:", url);
        } catch {
          console.warn("[scraper] Corrupt cache, ignoring:", url);
        }
      }
    } catch (err) {
      console.error("[scraper] Redis cache read failed:", err);
    }
  }

  // ─────────────────────────────────────────
  // 🔒 DISTRIBUTED LOCK (OPTIONAL)
  // ─────────────────────────────────────────
  let lockToken: string | null = null;
  let lockAcquired = false;

  if (redis) {
    try {
      lockToken = crypto.randomUUID();

      const acquired = await redis.set(lockKey, lockToken, {
        NX: true,
        EX: 10,
      });

      if (!acquired) {
        // Another worker is processing
        return { content: null, imageUrl: null };
      }

      lockAcquired = true;
    } catch (err) {
      console.error("[scraper] Redis lock failed:", err);
      // continue WITHOUT lock
    }
  }

  // ─────────────────────────────────────────
  // 🌐 FETCH + PARSE (CORE LOGIC)
  // ─────────────────────────────────────────
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Eaglespress/1.0)",
      },
    });

    if (!response.ok) {
      return { content: null, imageUrl: null };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove noise
    $(
      "script, style, nav, header, footer, aside, .ad, .advertisement, [aria-hidden='true']",
    ).remove();

    // Primary extraction
    let content = $(
      "article p, [role='main'] p, .article-body p, .post-content p, main p",
    )
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 40)
      .join("\n\n");

    // Fallback extraction
    if (!content) {
      content = $("p")
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length > 40)
        .join("\n\n");
    }

    const cleanContent = content.slice(0, 5000) || null;

    const imageUrl =
      $('meta[property="og:image"]').attr("content") ??
      $('meta[name="twitter:image"]').attr("content") ??
      null;

    const result: ScrapeResult = {
      content: cleanContent,
      imageUrl,
    };

    // ─────────────────────────────────────────
    // 💾 CACHE WRITE (OPTIONAL)
    // ─────────────────────────────────────────
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(result), {
          EX: 86400,
        });
      } catch (err) {
        console.error("[scraper] Redis cache write failed:", err);
      }
    }

    return result;
  } catch (err) {
    console.error(`[scraper] Failed to scrape ${url}:`, (err as Error).message);
    return { content: null, imageUrl: null };
  } finally {
    // ─────────────────────────────────────────
    // 🔓 SAFE UNLOCK (ONLY IF LOCKED)
    // ─────────────────────────────────────────
    if (redis && lockAcquired && lockToken) {
      try {
        await redis.eval(UNLOCK_SCRIPT, {
          keys: [lockKey],
          arguments: [lockToken],
        });
      } catch (err) {
        console.error(
          `[scraper] Failed to release lock for ${url}:`,
          (err as Error).message,
        );
      }
    }
  }
}
