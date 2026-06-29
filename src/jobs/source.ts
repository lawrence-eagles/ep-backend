import { db } from "../db";
import {
  sources,
  feedAliases,
  type Source,
  type NewSource,
} from "../db/schema";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────
// 🔥 URL NORMALIZATION (CANONICAL + DETERMINISTIC)
// ─────────────────────────────────────────────

export function normalizeFeedUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());

    // enforce https
    u.protocol = "https:";

    // normalize pathname
    u.pathname = u.pathname
      .replace(/\/+$/, "") // remove trailing slashes
      .replace(/\/(feed|rss)\/?$/i, ""); // safe suffix strip

    // remove noise
    u.search = "";
    u.hash = "";

    return u.toString();
  } catch {
    return raw.trim();
  }
}

// ─────────────────────────────────────────────
// 🔥 FEED REGISTRY (DO NOT CHANGE LIGHTLY)
// ─────────────────────────────────────────────

export const FEEDS = [
  { name: "CNN", url: "http://rss.cnn.com/rss/edition.rss" },
  { name: "BBC", url: "http://feeds.bbci.co.uk/news/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  {
    name: "NYTimes",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  },
  { name: "Guardian", url: "https://www.theguardian.com/world/rss" },
  { name: "Punch", url: "https://rss.punchng.com/v1/category/latest_news" },
  { name: "Vanguard", url: "https://www.vanguardngr.com/feed/" },
  { name: "Channels", url: "https://www.channelstv.com/feed/" },
  { name: "Arise", url: "https://www.arise.tv/feed/" },
  { name: "TechCabal", url: "https://techcabal.com/feed/" },
  {
    name: "Sahara Reporters",
    url: "https://saharareporters.com/articles/rss-feed",
  },
  { name: "Premium Times", url: "https://www.premiumtimesng.com/feed" },
  { name: "ThisDay Live", url: "https://www.thisdaylive.com/feed/" },
  { name: "Daily Post", url: "https://dailypost.ng/feed/" },
  {
    name: "ScienceDaily Health",
    url: "https://www.sciencedaily.com/rss/health_medicine.xml",
  },
  { name: "Men's Health", url: "https://www.menshealth.com/rss/all.xml" },
] as const;

export type FeedConfig = (typeof FEEDS)[number];

// ─────────────────────────────────────────────
// 🔥 NORMALIZED FEED MAP (KEY FIX)
// ─────────────────────────────────────────────

const FEED_MAP: Map<string, FeedConfig> = new Map(
  FEEDS.map((f) => [normalizeFeedUrl(f.url), f]),
);

export function getFeedConfig(url: string): FeedConfig | undefined {
  const normalized = normalizeFeedUrl(url);
  return FEED_MAP.get(normalized);
}

// ─────────────────────────────────────────────
// 🔥 RESOLVE SOURCE (ALIAS + CANONICAL)
// ─────────────────────────────────────────────

async function resolveSourceByUrl(
  normalizedUrl: string,
): Promise<Source | null> {
  // 1. Alias lookup
  const aliasResult = await db
    .select({ source: sources })
    .from(feedAliases)
    .innerJoin(sources, eq(feedAliases.sourceId, sources.id))
    .where(eq(feedAliases.aliasUrl, normalizedUrl))
    .limit(1);

  if (aliasResult.length > 0) {
    return aliasResult[0].source;
  }

  // 2. Canonical lookup
  const [existing] = await db
    .select()
    .from(sources)
    .where(eq(sources.url, normalizedUrl))
    .limit(1);

  return existing ?? null;
}

// ─────────────────────────────────────────────
// 🚀 MAIN: getOrCreateSource (PRODUCTION SAFE)
// ─────────────────────────────────────────────

export async function getOrCreateSource(feedUrl: string): Promise<Source> {
  const normalizedInput = normalizeFeedUrl(feedUrl);

  const feedConfig = getFeedConfig(normalizedInput);

  if (!feedConfig) {
    throw new Error(`Feed URL not registered: ${feedUrl}. Add to FEEDS first.`);
  }

  // canonical identity comes from registry
  const canonicalUrl = normalizeFeedUrl(feedConfig.url);

  // 1. Resolve existing
  const resolved = await resolveSourceByUrl(canonicalUrl);
  if (resolved) return resolved;

  const newSource: NewSource = {
    name: feedConfig.name,
    url: canonicalUrl,
  };

  // 2. Insert (race-safe)
  const [inserted] = await db
    .insert(sources)
    .values(newSource)
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    // self-alias ensures future matches
    await db
      .insert(feedAliases)
      .values({
        aliasUrl: canonicalUrl,
        sourceId: inserted.id,
      })
      .onConflictDoNothing();

    return inserted;
  }

  // 3. Race fallback
  const retry = await resolveSourceByUrl(canonicalUrl);
  if (retry) return retry;

  throw new Error(`Failed to get or create source for "${feedConfig.name}"`);
}
