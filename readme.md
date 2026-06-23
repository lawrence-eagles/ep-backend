# Todos

1. Solve Redis problem ✅
2. Solve source type import problem in source.ts ✅
3. Implement better auth completely

// bug in fetch news
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/jobs/fetchNews.ts` around lines 142 - 147, The deduplication logic that
sets the rawArticles dedupe keys using multi.set with getDedupeKey and
DEDUPE_TTL_SECONDS is executing before the articles are persisted to the
database. Move the entire forEach loop that calls multi.set for dedupe key
commitment to execute only after the articles have been successfully inserted
into the database. This ensures that if scrape, summarize, or insert operations
fail, the dedupe keys won't be set and the articles can be retried without being
suppressed for 24 hours.
