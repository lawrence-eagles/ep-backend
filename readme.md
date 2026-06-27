# Todos

1. Solve Redis problem ✅
2. Solve source type import problem in source.ts ✅
3. Implement better auth completely
4. Verify the isValidContent function learn what it does it seems too strong. ✅
5. Research how to implement protected route in better auth both for frontend and backend.
6. Implement protected routes where needed. ✅
7. Implement the next 5 routes
8. Update category keywords
9. Update RSS feeds

<!-- redis initialization at line 69 check if this is too early and if this needs to use safe redis helper as seen below: -->

src/controllers/bookmarksFeedController.ts

<!-- 1. decodeCursor() only parses JSON and casts it. A decodable cursor with missing or invalid createdAt / id will hit ::timestamp or ::uuid and return 500 instead of the intended 400. Also applies to: 94-99, 149-154 -->

src/controllers/feedsController.ts

<!-- 1. rank_score depends on NOW(), but the cursor stores a score from the previous request. On the next request, every score has decayed, so the keyset predicate can duplicate or skip posts near the page boundary.

2. With LIMIT 20 and rows.length === PAGE_SIZE, an exact 20-item final page still returns a cursor that only leads to an empty page. -->

src/controllers/followsHeadlinesController.ts

<!-- 1. rows.length === PAGE_SIZE cannot prove another page exists, so exact 20-item result sets get a dangling cursor. -->

src/controllers/trendingsController.ts

<!-- 1. A base64 JSON value like {} passes JSON.parse() and then reaches ::float, ::timestamp, or ::uuid, turning a bad cursor into a 500. Also applies to: 94-99, 153-163

2. buildTrendingKey() is shared across users, but the cached payload includes isLiked / isBookmarked. The first user's flags can be served to other authenticated users. Also applies to: 220-227

3. trend_score is computed with NOW(), but the cursor stores the previous score. On the next request every score has drifted, so the boundary can duplicate or skip rows. Also applies to: 153-164, 213-215 -->
