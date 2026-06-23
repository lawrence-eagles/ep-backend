import type { ScoreInput } from "./types";

// ── Signal weights ────────────────────────────────────────────────────────────
// Matches the scoring system designed for Eaglespress.
// At ingest time we only have static signals — engagement signals
// (shares, likes, comments) are added later via the trending score refresh job.

const WEIGHTS = {
  // Content quality signals
  hasImage: 10,
  longContent: 20, // max — scales with content length
  titleQuality: 5,
  freshness: 15, // max — decays with age
} as const;

// ── Recency decay ─────────────────────────────────────────────────────────────
// FIX: original score had "freshness boost (implicit via createdAt later)"
//      as a comment with no implementation. Now computed at ingest time.
// Score halves every 12 hours — news goes stale fast.

function freshnessScore(createdAt: Date | null): number {
  if (!createdAt) return 0;

  const hoursOld = Math.max(
    0,
    (Date.now() - createdAt.getTime()) / (1000 * 60 * 60),
  );
  // Exponential decay: full score when fresh, approaches 0 after ~36 hours
  return WEIGHTS.freshness * Math.pow(0.5, hoursOld / 12);
}

// ── Content length score ──────────────────────────────────────────────────────
// Log scale: long articles score higher but returns diminish past ~2000 chars

function contentScore(content: string): number {
  // log scale: 0 chars → 0, 500 chars → ~9, 2000 chars → ~15, 5000 chars → ~20
  return Math.min(
    Math.log1p(content.length / 100) * (WEIGHTS.longContent / Math.log1p(50)),
    WEIGHTS.longContent,
  );
}

// ── Title quality score ───────────────────────────────────────────────────────

function titleScore(title: string): number {
  const trimmed = title.trim();

  // Penalise very short titles (likely feed errors)
  if (trimmed.length < 10) return 0;

  // Reward informative-length titles (40-100 chars is the sweet spot)
  if (trimmed.length >= 40 && trimmed.length <= 100)
    return WEIGHTS.titleQuality;
  if (trimmed.length >= 20) return WEIGHTS.titleQuality * 0.6;

  return 0;
}

// ── Main score function ───────────────────────────────────────────────────────
//
// FIX: original score was purely additive with magic numbers and no
//      recency signal despite "freshness boost" being mentioned in a comment.
//      This version implements the proper scoring model.

export function calculatePostScore(input: ScoreInput): number {
  const score =
    (input.hasImage ? WEIGHTS.hasImage : 0) +
    contentScore(input.content) +
    titleScore(input.title) +
    freshnessScore(input.createdAt);

  return Math.round(score);
}
