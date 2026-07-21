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
  { name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  {
    name: "NYTimes",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  },
  { name: "France 24", url: "https://www.france24.com/en/rss" },
  { name: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
  {
    name: "The Conversation",
    url: "https://theconversation.com/global/articles.atom",
  },
  {
    name: "Firstpost",
    url: "https://www.firstpost.com/commonfeeds/v1/mfp/rss/world.xml",
  },
  { name: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { name: "UPI", url: "http://rss.upi.com/news/tn_int.rss" },
  {
    name: "WORLD NEWS INTERNATIONAL",
    url: "https://www.worldnewsintl.org/feed",
  },
  { name: "Punch", url: "https://rss.punchng.com/v1/category/latest_news" },
  { name: "Vanguard", url: "https://www.vanguardngr.com/feed/" },
  { name: "Channels", url: "https://www.channelstv.com/feed/" },
  { name: "Arise", url: "https://www.arise.tv/feed/" },
  {
    name: "Sahara Reporters",
    url: "https://saharareporters.com/articles/rss-feed",
  },
  { name: "Premium Times", url: "https://www.premiumtimesng.com/feed" },
  { name: "ThisDay Live", url: "https://www.thisdaylive.com/feed/" },
  { name: "Daily Post", url: "https://dailypost.ng/feed/" },
  {
    name: "Google News NG",
    url: "https://news.google.com/rss?topic=w&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "ScienceDaily Health",
    url: "https://www.sciencedaily.com/rss/top/health.xml",
  },
  { name: "Men's Health", url: "https://www.menshealth.com/rss/all.xml" },
  { name: "Medical Xpress", url: "https://medicalxpress.com/rss-feed/" },
  { name: "Kaiser Health News", url: "https://kffhealthnews.org/feed/" },
  { name: "FierceBiotech", url: "https://www.fiercebiotech.com/rss/xml" },
  { name: "FierceHealthcare", url: "https://www.fiercehealthcare.com/rss/xml" },
  { name: "Science News", url: "https://www.sciencenews.org/feed" },
  { name: "TechCabal", url: "https://techcabal.com/feed/" },
  {
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
  },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" }, // has game
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Wired", url: "https://www.wired.com/feed/rss" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { name: "ZDNet", url: "https://www.zdnet.com/news/rss.xml" },
  { name: "VentureBeat", url: "https://venturebeat.com/feed" },
  { name: "The Register", url: "https://www.theregister.com/headlines.atom" },
  {
    name: "Google News - Technology",
    url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "Google News - Technology NG",
    url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Bloomberg - Markets & Business",
    url: "https://feeds.bloomberg.com/markets/news.rss",
  },
  {
    name: "CNBC",
    url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  },
  {
    name: "Financial Times",
    url: "https://www.ft.com/rss/home/international",
  },
  {
    name: "Forbes - Business",
    url: "https://www.forbes.com/business/feed",
  },
  {
    name: "MarketWatch",
    url: "https://feeds.marketwatch.com/marketwatch/topstories",
  },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { name: "BusinessDay Nigeria", url: "https://businessday.ng/feed/" },
  { name: "Nairametrics", url: "https://nairametrics.com/feed/" },
  { name: "Business Post Nigeria", url: "https://businesspost.ng/feed/" },
  { name: "Business News Nigeria", url: "https://businessnews.com.ng/feed/" },
  {
    name: "Ripples Nigeria - Business",
    url: "https://www.ripplesnigeria.com/category/business/feed/",
  },
  { name: "Entrepreneurs.ng", url: "https://entrepreneurs.ng/feed/" },
  {
    name: "Google News Business - NG",
    url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-NG&gl=NG&ceid=NG:en",
  },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "NewsBTC", url: "https://www.newsbtc.com/feed/" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/" },
  { name: "BeInCrypto", url: "https://beincrypto.com/feed/" },
  { name: "AMBCrypto", url: "https://ambcrypto.com/feed/" },
  {
    name: "Google News Crypto - NG",
    url: "https://news.google.com/rss/search?q=cryptocurrency&hl=en-NG&gl=NG&ceid=NG:en",
  },
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
