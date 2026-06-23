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
  uuid,
  integer,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
  AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, InferSelectModel, InferInsertModel } from "drizzle-orm";

// BETTER AUTH GENERATED TABLES START
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// BETTER AUTH GENERATED TABLES END.

// Posts Table
// db/schema/posts.ts
// posts table with indexes
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    title: text("title").notNull(),

    // 🔥 UNIQUE (already indexed internally)
    slug: text("slug").notNull().unique(),

    description: text("description"),
    url: text("url").notNull(),
    imageUrl: text("image_url"),

    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, {
        onDelete: "cascade",
      }),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, {
        onDelete: "cascade",
      }),

    // 🔥 CORE RANKING SIGNAL
    score: integer("score").default(0),

    // 🔥 CLICK TRACKING
    clicks: integer("clicks").default(0).notNull(),

    // 🔥 MATERIALIZED COUNTERS
    likesCount: integer("likes_count").default(0).notNull(),
    commentsCount: integer("comments_count").default(0).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // 🔥 FEED / TRENDING (correct sort order)
    index("idx_posts_trending").on(
      t.score.desc(),
      t.createdAt.desc(),
      t.id.desc(),
    ),

    // 🔥 PAGINATION (cursor-based)
    index("idx_posts_created_at_id").on(t.createdAt.desc(), t.id.desc()),

    // 🔥 FILTERING
    index("idx_posts_category_id").on(t.categoryId),
    index("idx_posts_source_id").on(t.sourceId),

    // 🔥 FILTER + SORT (VERY IMPORTANT)
    index("idx_posts_category_created").on(t.categoryId, t.createdAt.desc()),

    // 🔥 SORTING
    index("idx_posts_score").on(t.score.desc()),

    // 🔥 ANALYTICS
    index("idx_posts_clicks").on(t.clicks),
  ],
);

// Source Table
// db/schema/sources.ts
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url: text("url").notNull().unique(),
});

// ✅ What you SELECT from DB
export type Source = InferSelectModel<typeof sources>;

// ✅ What you INSERT into DB
export type NewSource = InferInsertModel<typeof sources>;

// Category table
// db/schema/categories.ts
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(), // e.g. "Technology"
    slug: text("slug").notNull(), // e.g. "technology"

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // 🔥 UNIQUE NAME (case-sensitive — normalize in app layer)
    uniqueIndex("categories_name_idx").on(t.name),

    // 🔥 UNIQUE SLUG (used for routing)
    uniqueIndex("categories_slug_idx").on(t.slug),
  ],
);

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
  (t) => [
    // ✅ Composite Primary Key (enforces uniqueness + index)
    primaryKey({ columns: [t.userId, t.postId] }),

    // ✅ Fast lookup for "who liked this post"
    index("idx_likes_post_id").on(t.postId),

    // ✅ Fast lookup for "posts liked by user"
    index("idx_likes_user_id").on(t.userId),
  ],
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
  (t) => [
    // ✅ Composite Primary Key (enforces uniqueness + index)
    primaryKey({ columns: [t.userId, t.postId] }),

    // ✅ Fast lookup: all bookmarks for a post
    index("idx_bookmarks_post_id").on(t.postId),

    // ✅ Fast lookup: all bookmarks for a user (optional but recommended)
    index("idx_bookmarks_user_id").on(t.userId),
  ],
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

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, {
        onDelete: "cascade",
      }),

    // 🔥 FIX: break circular inference
    // 👉 This explicitly tells TypeScript: "Don’t try to infer this — it returns a column"
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_comments_post_id").on(t.postId),
    index("idx_comments_parent_id").on(t.parentId),
    index("idx_comments_post_created").on(t.postId, t.createdAt),
    index("idx_comments_user_id").on(t.userId),
  ],
);

// Follows Table
// db/schema/follows.ts

export const follows = pgTable(
  "follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade", // ✅ prevent orphan follows
      }),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, {
        onDelete: "cascade", // ✅ prevent orphan follows
      }),

    // ✅ Useful for sorting, analytics, debugging
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // ✅ Composite PK (also unique + indexed)
    primaryKey({ columns: [t.userId, t.categoryId] }),

    // ✅ Query: "followers of category"
    index("idx_follows_category_user").on(t.categoryId, t.userId),

    // ✅ Query: "categories followed by user"
    index("idx_follows_user_category").on(t.userId, t.categoryId),
  ],
);

// User behaviour Table
// db/schema/userBehavior.ts

export const userBehavior = pgTable(
  "user_behavior",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade", // ✅ prevent orphan rows
      }),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, {
        onDelete: "cascade", // ✅ prevent orphan rows
      }),

    // ✅ Must be NOT NULL for scoring math
    score: integer("score").default(0).notNull(),

    // ✅ NEW: when relationship was first created
    createdAt: timestamp("created_at").defaultNow().notNull(),

    // ✅ Useful for ranking/decay systems
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // ✅ Composite Primary Key
    primaryKey({ columns: [t.userId, t.categoryId] }),

    // ✅ Category-based queries (who is interested in X)
    index("idx_user_behavior_category_user").on(t.categoryId, t.userId),

    // ✅ User-based queries (what user likes)
    index("idx_user_behavior_user_category").on(t.userId, t.categoryId),
  ],
);

// Relations

// BETTER AUTH GENERATED RELATIONS START
// export const userRelations = relations(user, ({ many }) => ({
//   sessions: many(session),
//   accounts: many(account),
// }));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

// BETTER AUTH GENERATED RELATIONS END.

// User Relations UPDATED WITH BETTER AUTH RELATIONS BY ADDING -- sessions and account relations
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
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

export const schema = { user, session, account, verification };
