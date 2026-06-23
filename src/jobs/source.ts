import { db } from "../db";
import { sources, type Source, NewSource } from "../db/schema";
import { eq } from "drizzle-orm";

// ── Feed registry — single source of truth ────────────────────────────────────
// Use HTTPS feed URLs to prevent in-transit tampering. MAKE SURE TO USE HTTPS
// Keeping registry entries on HTTP weakens ingestion integrity and can let upstream content be modified on the network path.
export const FEEDS = [
  { name: "CNN", url: "http://rss.cnn.com/rss/edition.rss" },
  { name: "BBC", url: "http://feeds.bbci.co.uk/news/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  {
    name: "Reuters",
    url: "https://www.reutersagency.com/feed/?best-topics=business-finance",
  },
  {
    name: "NYTimes",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  },
  { name: "Guardian", url: "https://www.theguardian.com/world/rss" },
  { name: "Punch", url: "https://punchng.com/feed/" },
  { name: "Vanguard", url: "https://www.vanguardngr.com/feed/" },
  { name: "Channels", url: "https://www.channelstv.com/feed/" },
  { name: "Arise", url: "https://www.arise.tv/feed/" },
  { name: "TechCabal", url: "https://techcabal.com/feed/" },
  { name: "Bloomberg", url: "https://feeds.bloomberg.com/markets/news.rss" },
] as const;

export type FeedConfig = (typeof FEEDS)[number];

// O(1) lookup map — built once at module load
const FEED_MAP = new Map<string, FeedConfig>(FEEDS.map((f) => [f.url, f]));

export function getFeedConfig(url: string): FeedConfig | undefined {
  return FEED_MAP.get(url);
}

// ── Get or create source ──────────────────────────────────────────────────────
//
// Uses fetch → insert (onConflictDoNothing) → re-fetch pattern to handle
// concurrent Inngest function executions safely without throwing on
// duplicate key violations.

export async function getOrCreateSource(feedUrl: string): Promise<Source> {
  const feedConfig = getFeedConfig(feedUrl);

  if (!feedConfig) {
    throw new Error(
      `Feed URL not registered in FEEDS registry: ${feedUrl}. ` +
        `Add it to the FEEDS array in source.ts before using it.`,
    );
  }

  const { url, name } = feedConfig;
  // do not use NewSource type for select and for return vaues of your function.
  const newSource: NewSource = {
    name,
    url,
  };

  // 1. Fast path — source almost always exists after first run
  const [existing] = await db
    .select()
    .from(sources)
    .where(eq(sources.url, url))
    .limit(1);

  if (existing) return existing;

  // 2. Attempt insert — skips silently on duplicate (race-safe)
  const [inserted] = await db
    .insert(sources)
    .values(newSource)
    .onConflictDoNothing()
    .returning();

  if (inserted) return inserted;

  // 3. Concurrent request won the insert race — re-fetch
  const [retry] = await db
    .select()
    .from(sources)
    .where(eq(sources.url, url))
    .limit(1);

  if (retry) return retry;

  // 4. Unreachable — indicates missing UNIQUE constraint on sources.url
  throw new Error(
    `Failed to get or create source for "${name}" (${url}). ` +
      `Check that sources.url has a UNIQUE constraint in your Drizzle schema.`,
  );
}
