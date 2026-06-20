// Schemas

// APP TABLES
// user
// posts
// sources
// categories
// likes
// bookmarks
// comments
// follows
// user_behavior

// User Table
// db/schema/user.ts
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const user = pgTable("user", {
  id: text("id").primaryKey(), // from Better Auth

  email: text("email").notNull(),
  name: text("name"),
  image: text("image"),

  // 🔥 YOUR APP FIELDS
  username: text("username"),
  avatarUrl: text("avatar_url"),

  interests: jsonb("interests").$type<string[]>(),

  createdAt: timestamp("created_at").defaultNow(),
});

// Posts Table
// db/schema/posts.ts
// posts table with indexes
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    title: text("title").notNull(),

    // 🔥 UNIQUE + INDEXED LOOKUP (slug-based routing)
    slug: text("slug").notNull().unique(),

    description: text("description"),
    url: text("url").notNull(),
    imageUrl: text("image_url"),

    sourceId: uuid("source_id").references(() => sources.id),
    categoryId: uuid("category_id").references(() => categories.id),

    // 🔥 CORE RANKING SIGNAL
    score: integer("score").default(0),

    // 🔥 CLICK TRACKING
    clicks: integer("clicks").default(0).notNull(),

    // 🔥 MATERIALIZED COUNTERS
    likesCount: integer("likes_count").default(0).notNull(),
    commentsCount: integer("comments_count").default(0).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // 🔥 SLUG LOOKUP INDEX (critical for GET /:slug)
    idxPostsSlug: index("idx_posts_slug").on(t.slug),

    // 🔥 FEED / RANKING INDEX
    idxPostsTrending: index("idx_posts_trending").on(
      t.score,
      t.createdAt,
      t.id,
    ),

    // 🔥 PAGINATION INDEX (cursor-based)
    idxPostsCreatedAtId: index("idx_posts_created_at_id").on(t.createdAt, t.id),

    // 🔥 FILTERING
    idxPostsCategoryId: index("idx_posts_category_id").on(t.categoryId),
    idxPostsSourceId: index("idx_posts_source_id").on(t.sourceId),

    // 🔥 SORTING
    idxPostsScore: index("idx_posts_score").on(t.score),

    // 🔥 ANALYTICS / TRENDING BY ENGAGEMENT
    idxPostsClicks: index("idx_posts_clicks").on(t.clicks),
  }),
);

// Source Table
// db/schema/sources.ts
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url: text("url").notNull().unique(),
});

// Category table
// db/schema/categories.ts
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(), // e.g. "Technology"
    slug: text("slug").notNull(), // e.g. "technology"

    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex("categories_name_idx").on(t.name),
    slugIdx: uniqueIndex("categories_slug_idx").on(t.slug),
  }),
);

// /db/schema/interactions.ts

// Optional (Highly Recommended Upgrades)
// 1. Add comment threading index
// index("idx_comments_parent_id").on(t.parentId)
// 2. Add createdAt index (for sorting comments)
// index("idx_comments_post_created").on(t.postId, t.createdAt)
// WHEN PROMPTING CLAUDE REMEMBER TO TELL IT TO ADD ALL NECESSARY INDEXES
// =========================
// ❤️ LIKES TABLE
// =========================
export const likes = pgTable(
  "likes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    // ✅ Composite Primary Key (auto-indexed)
    pk: primaryKey({ columns: [t.userId, t.postId] }),

    // ✅ Needed for post-based queries (counts, joins, trending)
    idxLikesPostId: index("idx_likes_post_id").on(t.postId),
  }),
);

// =========================
// 🔖 BOOKMARKS TABLE
// =========================
export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    // ✅ Composite Primary Key (ALREADY indexed)
    pk: primaryKey({ columns: [t.userId, t.postId] }),
  }),
);

// =========================
// 💬 COMMENTS TABLE
// =========================
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    content: text("content").notNull(),

    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    postId: uuid("post_id").references(() => posts.id, {
      onDelete: "cascade",
    }),

    parentId: uuid("parent_id"),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    idxCommentsPostId: index("idx_comments_post_id").on(t.postId),

    // 🔥 NEW
    idxCommentsParentId: index("idx_comments_parent_id").on(t.parentId),

    idxCommentsPostCreated: index("idx_comments_post_created").on(
      t.postId,
      t.createdAt,
    ),
  }),
);

// Follows Table
// db/schema/follows.ts
export const follows = pgTable(
  "follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.categoryId] }),

    // 🔥 ADD THIS
    idxFollowsCategoryUser: index("idx_follows_category_user").on(
      t.categoryId,
      t.userId,
    ),
  }),
);

// User behaviour Table
// db/schema/userBehavior.ts
export const userBehavior = pgTable(
  "user_behavior",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),

    score: integer("score").default(0),
  },
  (t) => ({
    // ✅ Composite Primary Key
    pk: primaryKey({ columns: [t.userId, t.categoryId] }),

    // ✅ Index for fast JOINs (your requested one)
    idxCategoryUser: index("idx_user_behavior_category_user").on(
      t.categoryId,
      t.userId,
    ),
  }),
);

// ADD THE INDEX BELOW TO USER_BEHAVIOR TABLE
// index("idx_user_behavior_category").on(t.categoryId)

// Relations

// User Relations
export const userRelations = relations(user, ({ many }) => ({
  likes: many(likes),
  bookmarks: many(bookmarks),
  comments: many(comments),
  follows: many(follows),
  behavior: many(userBehavior),
}));

// Post Relations
export const postsRelations = relations(posts, ({ one, many }) => ({
  source: one(sources, {
    fields: [posts.sourceId],
    references: [sources.id],
  }),

  category: one(categories, {
    fields: [posts.categoryId],
    references: [categories.id],
  }),

  likes: many(likes),
  bookmarks: many(bookmarks),
  comments: many(comments),
}));

// Category Relations
export const categoriesRelations = relations(categories, ({ many }) => ({
  posts: many(posts),
  followers: many(follows),
  behavior: many(userBehavior),
}));

// 🔁 3. REQUIRED REVERSE RELATIONS (IMPORTANT)

// If you don’t add these, Drizzle won’t fully work.

// POSTS → CATEGORY
// inside postsRelations

// category: one(categories, {
//   fields: [posts.categoryId],
//   references: [categories.id],
// }),
// 🔔 FOLLOWS → CATEGORY
// db/relations/follows.ts

// category: one(categories, {
//   fields: [follows.categoryId],
//   references: [categories.id],
// }),
// 🧠 USER BEHAVIOR → CATEGORY
// db/relations/userBehavior.ts

// category: one(categories, {
//   fields: [userBehavior.categoryId],
//   references: [categories.id],
// }),

// Source Relations generated by copilot
export const sourcesRelations = relations(sources, ({ many }) => ({
  posts: many(posts),
}));

// Likes Relations
export const likesRelations = relations(likes, ({ one }) => ({
  user: one(user, {
    fields: [likes.userId],
    references: [user.id],
  }),

  post: one(posts, {
    fields: [likes.postId],
    references: [posts.id],
  }),
}));

// Comment Relations
export const commentsRelations = relations(comments, ({ one, many }) => ({
  user: one(user, {
    fields: [comments.userId],
    references: [user.id],
  }),

  post: one(posts, {
    fields: [comments.postId],
    references: [posts.id],
  }),

  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
  }),

  replies: many(comments),
}));

// Bookmark Relations
// db/relations/bookmarks.ts
export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(user, {
    fields: [bookmarks.userId],
    references: [user.id],
  }),

  post: one(posts, {
    fields: [bookmarks.postId],
    references: [posts.id],
  }),
}));

// Add reverse relations
// in userRelations
// bookmarks: many(bookmarks)

// in postsRelations
// bookmarks: many(bookmarks)

// Follows Relations
// db/relations/follows.ts
export const followsRelations = relations(follows, ({ one }) => ({
  user: one(user, {
    fields: [follows.userId],
    references: [user.id],
  }),

  category: one(categories, {
    fields: [follows.categoryId],
    references: [categories.id],
  }),
}));

// Reverse relations
// userRelations
// follows: many(follows)

// categoriesRelations
// followers: many(follows)

// user Behavior Relation
// db/relations/userBehavior.ts
export const userBehaviorRelations = relations(userBehavior, ({ one }) => ({
  user: one(user, {
    fields: [userBehavior.userId],
    references: [user.id],
  }),

  category: one(categories, {
    fields: [userBehavior.categoryId],
    references: [categories.id],
  }),
}));

// 🔁 Reverse relations
// userRelations
// behavior: many(userBehavior)

// categoriesRelations
// behavior: many(userBehavior)
