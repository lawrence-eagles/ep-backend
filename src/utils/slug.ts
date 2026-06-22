import { db } from "../db";
import { posts } from "../db/schema";
import { inArray } from "drizzle-orm";

// ── Generate base slug from title ─────────────────────────────────────────────

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

// ── Ensure unique slug ────────────────────────────────────────────────────────
//
// FIX 1: Off-by-one — original checked slug BEFORE generating the next one,
//         meaning the last candidate was never queried before falling back
//         to Date.now().
//
// FIX 2: N+1 queries — original fired one DB round-trip per iteration
//         (up to 50 queries). This version fires ONE query for all candidates.
//
// Strategy:
//   1. Build all candidate slugs upfront
//   2. Fetch ALL taken slugs in one query using inArray
//   3. Return first candidate not in the taken set
//   4. Fall back to timestamp only when all 100 variants are genuinely taken

export async function ensureUniqueSlug(baseSlug: string): Promise<string> {
  // Build all candidates: ["my-slug", "my-slug-1", ..., "my-slug-100"]
  const candidates = [
    baseSlug,
    ...Array.from({ length: 100 }, (_, i) => `${baseSlug}-${i + 1}`),
  ];

  // Single query — fetch all taken slugs from the candidate list
  const taken = await db
    .select({ slug: posts.slug })
    .from(posts)
    .where(inArray(posts.slug, candidates));

  const takenSet = new Set(taken.map((r) => r.slug));

  // Return first available candidate
  const available = candidates.find((slug) => !takenSet.has(slug));

  // Guaranteed unique fallback (only reached if all 101 variants are taken)
  return available ?? `${baseSlug}-${Date.now()}`;
}
