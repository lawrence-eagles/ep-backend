import { db } from "../db";
import { categories } from "../db/schema";
import { eq } from "drizzle-orm";

// ── Keyword map ───────────────────────────────────────────────────────────────
// Ensure you always store: name → normalized (e.g. Title Case or lowercase)
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Technology: [
    "ai",
    "tech",
    "software",
    "startup",
    "mobile",
    "cyber",
    "digital",
    "app",
    "robot",
  ],
  Business: [
    "market",
    "finance",
    "economy",
    "stock",
    "trade",
    "gdp",
    "inflation",
    "investment",
  ],
  Politics: [
    "election",
    "government",
    "policy",
    "president",
    "parliament",
    "senate",
    "congress",
    "vote",
  ],
  Health: [
    "covid",
    "health",
    "medicine",
    "hospital",
    "vaccine",
    "disease",
    "mental health",
    "fda",
  ],
  Science: [
    "nasa",
    "space",
    "research",
    "climate",
    "environment",
    "study",
    "scientist",
    "discovery",
  ],
  World: [
    "war",
    "conflict",
    "international",
    "united nations",
    "diplomacy",
    "sanctions",
  ],
  Crypto: ["bitcoin", "ethereum"],
};

// ── Slugify ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ── Classify text into a category ────────────────────────────────────────────

function classifyText(text: string): string {
  const lower = text.toLowerCase();
  let bestCategory = "General";
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.reduce((acc, word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`\\b${escaped}\\b`, "i");
      return acc + (pattern.test(text) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

// ── Get or create category ────────────────────────────────────────────────────
//
// FIX 1: Original used raw db.execute(sql`...`) which bypasses Drizzle's
//        type system entirely. result.rows[0].id is typed as unknown and
//        crashes at runtime if the row is missing.
//
// FIX 2: The DO UPDATE SET name = EXCLUDED.name was a no-op (updating
//        with the same value it already has). Changed to onConflictDoNothing
//        + re-fetch which is clearer and correct.
//
// FIX 3: Return type is now string (guaranteed) instead of any.

export async function detectCategoryId(text: string): Promise<string> {
  const name = classifyText(text);
  const slug = slugify(name);

  // Fast path — category likely already exists
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name))
    .limit(1);

  if (existing) return existing.id;

  // Insert — skip on duplicate (race-safe)
  const [inserted] = await db
    .insert(categories)
    .values({ name, slug })
    .onConflictDoNothing()
    .returning({ id: categories.id });

  if (inserted) return inserted.id;

  // Concurrent insert won the race — re-fetch
  const [retry] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, name))
    .limit(1);

  if (retry) return retry.id;

  throw new Error(
    `Failed to get or create category "${name}". ` +
      `Check that categories.name has a UNIQUE constraint in your schema.`,
  );
}
