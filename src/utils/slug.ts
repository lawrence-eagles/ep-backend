import { db } from "../db";
import { posts } from "../db/schema";
import { eq } from "drizzle-orm";

// ── Generate base slug ─────────────────────────────────────────────

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

// ── Type guard for unique constraint errors ────────────────────────
//
// Works for Postgres (pg), Neon, etc.

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const e = err as any;

  // Postgres error code for unique violation
  return e.code === "23505";
}

// ── Build slug candidates ──────────────────────────────────────────

function buildSlugCandidates(baseSlug: string): string[] {
  return [
    baseSlug,
    ...Array.from({ length: 100 }, (_, i) => `${baseSlug}-${i + 1}`),
  ];
}

// ── Insert with concurrency-safe slug handling ─────────────────────
//
// This is the ONLY safe way to guarantee uniqueness under concurrency.
//
// Strategy:
//   1. Try inserting with candidate slug
//   2. If unique constraint fails → try next
//   3. Fallback to timestamp slug
//
// NOTE: This function owns the insert step (important!)

export async function insertPostWithUniqueSlug(
  data: Omit<typeof posts.$inferInsert, "slug"> & { title: string },
) {
  const baseSlug = generateSlug(data.title);
  const candidates = buildSlugCandidates(baseSlug);

  // Try all candidates first
  for (const slug of candidates) {
    try {
      const result = await db
        .insert(posts)
        .values({
          ...data,
          slug,
        })
        .returning();

      return result[0];
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Slug already taken → try next
        continue;
      }

      // Unknown DB error → rethrow
      throw err;
    }
  }

  // अंतिम fallback (guaranteed unique)
  const fallbackSlug = `${baseSlug}-${Date.now()}`;

  try {
    const result = await db
      .insert(posts)
      .values({
        ...data,
        slug: fallbackSlug,
      })
      .returning();

    return result[0];
  } catch (err) {
    // Extremely unlikely unless DB is broken
    throw new Error(
      `Failed to insert post even after slug fallback: ${(err as Error).message}`,
    );
  }
}

// ── Optional helper (if you still want slug-only generation) ───────
//
// ⚠️ NOT concurrency-safe by itself
// Only use for preview/UI purposes

export async function ensureUniqueSlug(baseSlug: string): Promise<string> {
  const candidates = buildSlugCandidates(baseSlug);

  const existing = await db
    .select({ slug: posts.slug })
    .from(posts)
    .where(eq(posts.slug, baseSlug)); // lightweight check

  if (existing.length === 0) return baseSlug;

  return `${baseSlug}-${Date.now()}`;
}
