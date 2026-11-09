import type { Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getRedis } from "../../lib/redis";
import { buildCommentsKey } from "../../utils/cache";

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
const REPLIES_PAGE_SIZE = 5;
const CACHE_TTL = 60;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 60;

// ─────────────────────────────────────────────────────────────
// UUID VALIDATION
// ─────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

interface Cursor {
  created_at: string;
  id: string;
}

interface CommentNode {
  id: string;
  created_at: string;
  content: string;
  user_id: string;
  userName: string;
  userImage: string | null;
  likesCount: number | string;
  isLiked: boolean;
  replies: CommentNode[];
  repliesNextCursor: string | null;
  repliesHasMore: boolean;
}

// ─────────────────────────────────────────────────────────────
// SAFE REDIS HELPER
// ─────────────────────────────────────────────────────────────

async function getRedisSafe() {
  try {
    return await getRedis();
  } catch (err) {
    console.error("REDIS INIT ERROR:", err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────

async function rateLimit(userId: string, keySuffix: string) {
  const redis = await getRedisSafe();

  // Fail open if Redis is unavailable.
  if (!redis) return;

  const key = `rate:${keySuffix}:${userId}`;

  let count: number;

  try {
    count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }
  } catch (err) {
    console.error("RATE LIMIT ERROR:", err);
    return;
  }

  if (count > RATE_LIMIT_MAX) {
    throw new Error("Too many requests");
  }
}

// ─────────────────────────────────────────────────────────────
// CURSOR ENCODING
// ─────────────────────────────────────────────────────────────

function encodeCursor(data: Cursor): string {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

// ─────────────────────────────────────────────────────────────
// CURSOR DECODING
// ─────────────────────────────────────────────────────────────

function decodeCursor(cursor: string): Cursor {
  try {
    if (cursor.length > 1000) {
      throw new Error();
    }

    const raw = Buffer.from(cursor, "base64url").toString("utf-8");

    if (raw.length > 500) {
      throw new Error();
    }

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }

    const { created_at, id } = parsed;

    if (typeof created_at !== "string" || typeof id !== "string") {
      throw new Error();
    }

    if (!UUID_RE.test(id)) {
      throw new Error();
    }

    const date = new Date(created_at);

    if (isNaN(date.getTime())) {
      throw new Error();
    }

    return {
      created_at: date.toISOString(),
      id,
    };
  } catch {
    throw new Error("Invalid cursor");
  }
}

// ─────────────────────────────────────────────────────────────
// PERSONALIZATION CACHE SIGNATURE
// ─────────────────────────────────────────────────────────────

/**
 * Generates a deterministic signature using:
 *
 * 1. Users blocked by the authenticated user.
 * 2. Comments and replies hidden by the authenticated user.
 *
 * This ensures that changes to either relationship
 * automatically produce a different Redis cache key.
 *
 * No Redis SCAN or explicit cache invalidation is required.
 */
async function getPersonalizationSignature(userId: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT
      md5(
        COALESCE(
          (
            SELECT jsonb_agg(
              ub.blocked_id ORDER BY ub.blocked_id
            )::text
            FROM user_blocks ub
            WHERE ub.blocker_id = ${userId}
          ),
          '[]'
        )
        ||
        ':'
        ||
        COALESCE(
          (
            SELECT jsonb_agg(
              uh.comment_id ORDER BY uh.comment_id
            )::text
            FROM user_hidden_comments uh
            WHERE uh.user_id = ${userId}
          ),
          '[]'
        )
      ) AS signature
  `);

  const signature = result.rows[0]?.signature;

  if (typeof signature !== "string") {
    throw new Error("Failed to generate personalization cache signature");
  }

  return signature;
}

// ─────────────────────────────────────────────────────────────
// BUILD COMMENT NODE
// ─────────────────────────────────────────────────────────────

function buildCommentNode(row: any): CommentNode {
  return {
    id: row.id,
    created_at: row.created_at,
    content: row.content,
    user_id: row.user_id,
    userName: row.user_name,
    userImage: row.user_image,
    likesCount: row.likes_count,
    isLiked: row.is_liked,

    replies: [],

    repliesNextCursor: null,
    repliesHasMore: false,
  };
}

// ─────────────────────────────────────────────────────────────
// BUILD REPLY PAGINATION CURSOR
// ─────────────────────────────────────────────────────────────

function buildReplyCursor(
  replies: CommentNode[],
  hasMore: boolean,
): string | null {
  if (!hasMore || replies.length === 0) {
    return null;
  }

  const lastReply = replies[replies.length - 1];

  return encodeCursor({
    created_at: new Date(lastReply.created_at).toISOString(),
    id: lastReply.id,
  });
}

// ─────────────────────────────────────────────────────────────
// FETCH COMMENTS CONTROLLER
// GET /api/v1/posts/:postId/comments
// ─────────────────────────────────────────────────────────────

export const fetchCommentsVersionOne = async (req: Request, res: Response) => {
  try {
    const redis = await getRedisSafe();

    // ─────────────────────────────────────────────────────────
    // AUTHENTICATION
    // ─────────────────────────────────────────────────────────

    const userId = req.user?.id ?? null;

    await rateLimit(userId ?? `ip:${req.ip}`, "fetch_comments");

    // ─────────────────────────────────────────────────────────
    // VALIDATE POST ID
    // ─────────────────────────────────────────────────────────

    let { postId } = req.params;

    if (Array.isArray(postId)) {
      postId = postId[0];
    }

    if (!postId || !UUID_RE.test(postId)) {
      return res.status(400).json({
        error: "Invalid postId",
      });
    }

    // ─────────────────────────────────────────────────────────
    // VALIDATE PARENT ID
    // ─────────────────────────────────────────────────────────

    const parentIdParam = req.query.parentId;

    if (parentIdParam !== undefined && typeof parentIdParam !== "string") {
      return res.status(400).json({
        error: "Invalid parentId",
      });
    }

    const parentId = parentIdParam as string | undefined;

    if (parentId !== undefined && !UUID_RE.test(parentId)) {
      return res.status(400).json({
        error: "Invalid parentId",
      });
    }

    // ─────────────────────────────────────────────────────────
    // VALIDATE CURSOR
    // ─────────────────────────────────────────────────────────

    const cursorParam = req.query.cursor;

    if (cursorParam !== undefined && typeof cursorParam !== "string") {
      return res.status(400).json({
        error: "Invalid cursor",
      });
    }

    const cursor = cursorParam as string | undefined;

    let decodedCursor: Cursor | null = null;

    if (cursor) {
      try {
        decodedCursor = decodeCursor(cursor);
      } catch {
        return res.status(400).json({
          error: "Invalid cursor",
        });
      }
    }

    // ─────────────────────────────────────────────────────────
    // ACTIVE COMMENT RESTRICTION CHECK
    // ─────────────────────────────────────────────────────────

    // This check must happen before the Redis cache lookup.
    // Otherwise, a previously cached comment response could allow
    // a restricted user to continue viewing comments.

    if (userId) {
      const commentBanResult = await db.execute<{ user_id: string }>(sql`
        SELECT user_id
        FROM user_comment_bans
        WHERE user_id = ${userId}
          AND (
            expires_at IS NULL
            OR expires_at > NOW()
          )
        LIMIT 1
      `);

      if (commentBanResult.rows.length > 0) {
        // Do not read from or write to the comment cache for
        // users with an active comment restriction.

        return res.json({
          comments: [],
          nextCursor: null,
          hasMore: false,
        });
      }
    }

    // ─────────────────────────────────────────────────────────
    // PERSONALIZED CACHE KEY
    // ─────────────────────────────────────────────────────────

    let cacheUserId: string | null = userId;

    if (userId) {
      const personalizationSignature =
        await getPersonalizationSignature(userId);

      cacheUserId = `${userId}:personalization:${personalizationSignature}`;
    }

    /**
     * Root comment requests and parent-scoped reply requests
     * must have different cache keys.
     *
     * The parent ID is included in the reply cache scope so
     * replies belonging to different parents cannot share cache
     * entries.
     */
    const cacheCursor = parentId
      ? `replies:${parentId}:${cursor ?? "first"}`
      : (cursor ?? null);

    const cacheKey = await buildCommentsKey(postId, cacheCursor, cacheUserId);

    // ─────────────────────────────────────────────────────────
    // BLOCK FILTER CONDITIONS
    // ─────────────────────────────────────────────────────────

    /**
     * Anonymous users:
     * - See public comments.
     *
     * Authenticated users:
     * - Do not see comments from users they blocked.
     * - Do not see comments from users who blocked them
     *   unless your existing block policy specifies otherwise.
     *
     * The filtering is applied at every reply depth.
     */

    const rootBlockFilter = userId
      ? sql`
          AND NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE ub.blocker_id = ${userId}
              AND ub.blocked_id = c.user_id
          )
        `
      : sql``;

    const rootHiddenFilter = userId
      ? sql`
          AND NOT EXISTS (
            SELECT 1
            FROM user_hidden_comments uh
            WHERE uh.user_id = ${userId}
              AND uh.comment_id = c.id
          )
        `
      : sql``;

    const replyBlockFilter = userId
      ? sql`
          AND NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE ub.blocker_id = ${userId}
              AND ub.blocked_id = r.user_id
          )
        `
      : sql``;

    const replyHiddenFilter = userId
      ? sql`
          AND NOT EXISTS (
            SELECT 1
            FROM user_hidden_comments uh
            WHERE uh.user_id = ${userId}
              AND uh.comment_id = r.id
          )
        `
      : sql``;

    // ─────────────────────────────────────────────────────────
    // PARENT-SCOPED REPLY PAGINATION
    // ─────────────────────────────────────────────────────────

    /**
     * When parentId is supplied, this branch fetches the next
     * page of replies belonging to that specific parent.
     *
     * This supports:
     *
     * - Replies belonging to root comments.
     * - Replies belonging to direct replies.
     * - Replies belonging to grandchildren.
     * - Replies belonging to any subsequent nesting level.
     *
     * The cursor is applied to the selected parent's children,
     * rather than to root comments.
     *
     * Visibility checks are performed on the parent and its
     * complete ancestor chain before returning any children.
     */

    if (parentId) {
      // ───────────────────────────────────────────────────────
      // VALIDATE PARENT VISIBILITY AND OWNERSHIP
      // ───────────────────────────────────────────────────────

      const parentBlockVisibility = userId
        ? sql`
            OR EXISTS (
              SELECT 1
              FROM user_blocks ub
              WHERE ub.blocker_id = ${userId}
                AND ub.blocked_id = pc.user_id
            )
          `
        : sql``;

      const parentHiddenVisibility = userId
        ? sql`
            OR EXISTS (
              SELECT 1
              FROM user_hidden_comments uh
              WHERE uh.user_id = ${userId}
                AND uh.comment_id = pc.id
            )
          `
        : sql``;

      /**
       * Walk from the requested parent towards the root.
       *
       * A parent is accessible only if:
       * - It belongs to the requested post.
       * - It exists.
       * - It and every ancestor are not soft-deleted.
       * - It and every ancestor are not hidden by this user.
       * - It and every ancestor pass the block filter.
       * - The ancestry reaches a root comment.
       *
       * This prevents clients from using a known parent ID
       * to retrieve replies beneath an inaccessible comment.
       *
       * The path array also protects against circular ancestry.
       */

      const parentVisibilityResult = await db.execute(sql`
        WITH RECURSIVE parent_chain AS (

          SELECT
            p.id,
            p.parent_id,
            p.post_id,
            p.user_id,
            p.is_deleted,

            ARRAY[p.id]::uuid[] AS path

          FROM comments p

          WHERE p.id = ${parentId}::uuid
            AND p.post_id = ${postId}::uuid

          UNION ALL

          SELECT
            ancestor.id,
            ancestor.parent_id,
            ancestor.post_id,
            ancestor.user_id,
            ancestor.is_deleted,

            chain.path || ancestor.id

          FROM comments ancestor

          JOIN parent_chain chain
            ON ancestor.id = chain.parent_id

          WHERE ancestor.post_id = ${postId}::uuid
            AND NOT (ancestor.id = ANY(chain.path))
        )

        SELECT

          EXISTS (
            SELECT 1
            FROM parent_chain
          ) AS parent_exists,

          EXISTS (
            SELECT 1
            FROM parent_chain
            WHERE parent_id IS NULL
          ) AS reaches_root,

          NOT EXISTS (
            SELECT 1
            FROM parent_chain pc
            WHERE pc.is_deleted = TRUE
              ${parentBlockVisibility}
              ${parentHiddenVisibility}
          ) AS is_visible
      `);

      const parentVisibility = parentVisibilityResult.rows[0];

      const parentExists = parentVisibility?.parent_exists === true;
      const reachesRoot = parentVisibility?.reaches_root === true;
      const parentIsVisible = parentVisibility?.is_visible === true;

      if (!parentExists || !reachesRoot || !parentIsVisible) {
        return res.status(404).json({
          error: "Comment not found",
        });
      }

      // ───────────────────────────────────────────────────────
      // REDIS CACHE GET
      // ───────────────────────────────────────────────────────

      if (redis) {
        try {
          const cached = await redis.get(cacheKey);

          if (cached) {
            return res.json(JSON.parse(cached));
          }
        } catch (err) {
          console.error("REDIS GET ERROR:", err);
        }
      }

      // ───────────────────────────────────────────────────────
      // REPLY CURSOR CONDITION
      // ───────────────────────────────────────────────────────

      const replyCursorCondition = decodedCursor
        ? sql`
            AND (r.created_at, r.id) < (
              ${decodedCursor.created_at}::timestamptz,
              ${decodedCursor.id}::uuid
            )
          `
        : sql``;

      // ───────────────────────────────────────────────────────
      // FETCH NEXT PAGE OF REPLIES
      // ───────────────────────────────────────────────────────

      /**
       * Fetch five visible children plus one additional row.
       *
       * The sixth row is used only to determine hasMore.
       *
       * Filtering happens before ORDER BY, window counting
       * and LIMIT so deleted, blocked and hidden replies
       * do not consume the five-reply page limit.
       *
       * The composite cursor guarantees deterministic
       * pagination using created_at and id.
       */

      const repliesResult = await db.execute(sql`
        SELECT

          r.id,
          r.created_at,
          r.content,
          r.user_id,
          r.parent_id,

          u.image AS user_image,
          u.name AS user_name,

          r.likes_count,

          EXISTS (
            SELECT 1
            FROM comment_likes cl
            WHERE cl.comment_id = r.id
            ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
          ) AS is_liked,

          COUNT(*) OVER ()::integer AS sibling_count

        FROM comments r

        JOIN "user" u
          ON u.id = r.user_id

        WHERE r.post_id = ${postId}::uuid

          AND r.parent_id = ${parentId}::uuid

          AND r.is_deleted = FALSE

          ${replyBlockFilter}

          ${replyHiddenFilter}

          ${replyCursorCondition}

        ORDER BY
          r.created_at DESC,
          r.id DESC

        LIMIT ${REPLIES_PAGE_SIZE + 1}
      `);

      // ───────────────────────────────────────────────────────
      // DETERMINE REPLY PAGINATION
      // ───────────────────────────────────────────────────────

      const hasMore = repliesResult.rows.length > REPLIES_PAGE_SIZE;

      const replyRows = repliesResult.rows.slice(0, REPLIES_PAGE_SIZE) as any[];

      // ───────────────────────────────────────────────────────
      // BUILD REPLY NODES
      // ───────────────────────────────────────────────────────

      const replies = replyRows.map((row) => buildCommentNode(row));

      // ───────────────────────────────────────────────────────
      // BUILD NEXT REPLY CURSOR
      // ───────────────────────────────────────────────────────

      const nextCursor = buildReplyCursor(replies, hasMore);

      // ───────────────────────────────────────────────────────
      // BUILD REPLY RESPONSE
      // ───────────────────────────────────────────────────────

      const response = {
        parentId,
        replies,
        nextCursor,
        hasMore,
      };

      // ───────────────────────────────────────────────────────
      // REDIS CACHE SET
      // ───────────────────────────────────────────────────────

      if (redis) {
        try {
          await redis.set(cacheKey, JSON.stringify(response), {
            EX: CACHE_TTL,
          });
        } catch (err) {
          console.error("REDIS SET ERROR:", err);
        }
      }

      return res.json(response);
    }

    // ─────────────────────────────────────────────────────────
    // ROOT COMMENT CURSOR CONDITION
    // ─────────────────────────────────────────────────────────

    const cursorCondition = decodedCursor
      ? sql`
          AND (c.created_at, c.id) < (
            ${decodedCursor.created_at}::timestamptz,
            ${decodedCursor.id}::uuid
          )
        `
      : sql``;

    // ─────────────────────────────────────────────────────────
    // REDIS CACHE GET
    // ─────────────────────────────────────────────────────────

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);

        if (cached) {
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        console.error("REDIS GET ERROR:", err);
      }
    }

    // ─────────────────────────────────────────────────────────
    // FETCH ROOT COMMENTS
    // ─────────────────────────────────────────────────────────

    /**
     * Filtering occurs inside PostgreSQL before:
     *
     * - Soft-deleted comment filtering.
     * - User block filtering.
     * - User hidden-comment filtering.
     * - ORDER BY.
     * - LIMIT.
     * - Pagination.
     *
     * Deleted, hidden, and blocked comments therefore do not
     * consume the user's 10-comment page limit.
     */

    const commentsQuery = sql`
      SELECT
        c.id,
        c.created_at,
        c.content,
        c.user_id,

        u.image AS user_image,
        u.name AS user_name,

        c.likes_count,

        EXISTS (
          SELECT 1
          FROM comment_likes cl
          WHERE cl.comment_id = c.id
          ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
        ) AS is_liked

      FROM comments c

      JOIN "user" u
        ON u.id = c.user_id

      WHERE c.post_id = ${postId}
        AND c.parent_id IS NULL
        AND c.is_deleted = FALSE

        ${rootBlockFilter}

        ${rootHiddenFilter}

        ${cursorCondition}

      ORDER BY
        c.created_at DESC,
        c.id DESC

      LIMIT ${PAGE_SIZE + 1}
    `;

    const result = await db.execute(commentsQuery);

    const hasMore = result.rows.length > PAGE_SIZE;

    const rootComments = result.rows.slice(0, PAGE_SIZE) as any[];

    // ─────────────────────────────────────────────────────────
    // HANDLE EMPTY COMMENTS
    // ─────────────────────────────────────────────────────────

    if (rootComments.length === 0) {
      const emptyResponse = {
        comments: [],
        nextCursor: null,
        hasMore: false,
      };

      if (redis) {
        try {
          await redis.set(cacheKey, JSON.stringify(emptyResponse), {
            EX: CACHE_TTL,
          });
        } catch (err) {
          console.error("REDIS SET ERROR:", err);
        }
      }

      return res.json(emptyResponse);
    }

    // ─────────────────────────────────────────────────────────
    // ROOT COMMENT IDS
    // ─────────────────────────────────────────────────────────

    const rootIds = rootComments.map((comment) => comment.id);

    const rootIdsSQL = sql.join(
      rootIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    // ─────────────────────────────────────────────────────────
    // RECURSIVELY FETCH ALL REPLY LEVELS
    // ─────────────────────────────────────────────────────────

    /**
     * Recursive comment retrieval.
     *
     * The first recursive level retrieves direct replies.
     * Subsequent levels retrieve replies to those replies.
     *
     * Pagination:
     * - Maximum 5 visible replies per parent.
     * - An additional reply is fetched to determine hasMore.
     * - Each parent receives independent pagination metadata.
     *
     * Cycle protection:
     * - Tracks visited UUIDs using a PostgreSQL UUID array.
     * - Prevents a comment from appearing in its own ancestry.
     *
     * Soft-deleted, hidden, and blocked replies are filtered
     * before LIMIT.
     */

    const repliesResult = await db.execute(sql`
      WITH RECURSIVE comment_tree AS (

        -- ───────────────────────────────────────────────────
        -- FIRST LEVEL: DIRECT REPLIES TO ROOT COMMENTS
        -- ───────────────────────────────────────────────────

        SELECT
          root.id AS root_id,

          child.id,
          child.parent_id,
          child.created_at,
          child.content,
          child.user_id,

          child.user_image,
          child.user_name,

          child.likes_count,
          child.is_liked,

          1::integer AS depth,

          child.sibling_position,
          child.sibling_count,

          ARRAY[root.id, child.id]::uuid[] AS path

        FROM comments root

        CROSS JOIN LATERAL (

          SELECT
            r.id,
            r.parent_id,
            r.created_at,
            r.content,
            r.user_id,

            u.image AS user_image,
            u.name AS user_name,

            r.likes_count,

            EXISTS (
              SELECT 1
              FROM comment_likes cl
              WHERE cl.comment_id = r.id
              ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
            ) AS is_liked,

            ROW_NUMBER() OVER (
              ORDER BY
                r.created_at DESC,
                r.id DESC
            )::integer AS sibling_position,

            COUNT(*) OVER ()::integer AS sibling_count

          FROM comments r

          JOIN "user" u
            ON u.id = r.user_id

          WHERE r.parent_id = root.id
            AND r.is_deleted = FALSE

            ${replyBlockFilter}

            ${replyHiddenFilter}

          ORDER BY
            r.created_at DESC,
            r.id DESC

          LIMIT ${REPLIES_PAGE_SIZE + 1}

        ) child

        WHERE root.id IN (${rootIdsSQL})

        UNION ALL

        -- ───────────────────────────────────────────────────
        -- RECURSIVE LEVEL: REPLIES TO REPLIES
        -- ───────────────────────────────────────────────────

        SELECT
          tree.root_id,

          child.id,
          child.parent_id,
          child.created_at,
          child.content,
          child.user_id,

          child.user_image,
          child.user_name,

          child.likes_count,
          child.is_liked,

          tree.depth + 1 AS depth,

          child.sibling_position,
          child.sibling_count,

          tree.path || child.id AS path

        FROM comment_tree tree

        CROSS JOIN LATERAL (

          SELECT
            r.id,
            r.parent_id,
            r.created_at,
            r.content,
            r.user_id,

            u.image AS user_image,
            u.name AS user_name,

            r.likes_count,

            EXISTS (
              SELECT 1
              FROM comment_likes cl
              WHERE cl.comment_id = r.id
              ${userId ? sql`AND cl.user_id = ${userId}` : sql`AND FALSE`}
            ) AS is_liked,

            ROW_NUMBER() OVER (
              ORDER BY
                r.created_at DESC,
                r.id DESC
            )::integer AS sibling_position,

            COUNT(*) OVER ()::integer AS sibling_count

          FROM comments r

          JOIN "user" u
            ON u.id = r.user_id

          WHERE r.parent_id = tree.id
            AND r.is_deleted = FALSE

            ${replyBlockFilter}

            ${replyHiddenFilter}

            -- Prevent circular comment relationships.
            AND NOT (r.id = ANY(tree.path))

          ORDER BY
            r.created_at DESC,
            r.id DESC

          LIMIT ${REPLIES_PAGE_SIZE + 1}

        ) child

        -- Only the first 5 visible replies of each parent
        -- are expanded to retrieve their descendants.
        WHERE tree.sibling_position <= ${REPLIES_PAGE_SIZE}
      )

      SELECT
        root_id,

        id,
        parent_id,
        created_at,
        content,
        user_id,

        user_image,
        user_name,

        likes_count,
        is_liked,

        depth,
        sibling_position,
        sibling_count

      FROM comment_tree

      -- Do not return the sixth reply.
      -- It is used only to determine whether more exist.
      WHERE sibling_position <= ${REPLIES_PAGE_SIZE}

      ORDER BY
        depth ASC,
        parent_id,
        sibling_position ASC
    `);

    // ─────────────────────────────────────────────────────────
    // BUILD ROOT COMMENT MAP
    // ─────────────────────────────────────────────────────────

    const rootMap = new Map<string, CommentNode>();

    for (const row of rootComments) {
      rootMap.set(row.id, buildCommentNode(row));
    }

    // ─────────────────────────────────────────────────────────
    // BUILD REPLY NODE MAP
    // ─────────────────────────────────────────────────────────

    /**
     * Every retrieved reply is first converted into a node.
     *
     * This allows us to attach grandchildren and deeper
     * descendants without depending on SQL row ordering.
     */

    const replyNodeMap = new Map<string, CommentNode>();

    // Keep the parent pagination information separately.
    const replyPaginationMap = new Map<
      string,
      {
        hasMore: boolean;
      }
    >();

    const replyRows = repliesResult.rows as any[];

    for (const row of replyRows) {
      const node = buildCommentNode(row);

      replyNodeMap.set(row.id, node);

      // Pagination metadata belongs to the parent whose children
      // are represented by this row, not to the row itself.
      replyPaginationMap.set(row.parent_id, {
        hasMore: Number(row.sibling_count) > REPLIES_PAGE_SIZE,
      });
    }

    // ─────────────────────────────────────────────────────────
    // ATTACH REPLIES TO THEIR PARENTS
    // ─────────────────────────────────────────────────────────

    /**
     * First attach direct replies to root comments.
     *
     * Then attach grandchildren and deeper descendants
     * to their respective parent reply nodes.
     *
     * This creates a properly nested comment tree.
     */

    for (const row of replyRows) {
      const node = replyNodeMap.get(row.id);

      if (!node) {
        continue;
      }

      const parentId = row.parent_id;

      // Parent is another reply.
      const parentReply = replyNodeMap.get(parentId);

      if (parentReply) {
        parentReply.replies.push(node);
        continue;
      }

      // Parent is a root comment.
      const rootComment = rootMap.get(parentId);

      if (rootComment) {
        rootComment.replies.push(node);
      }
    }

    // ─────────────────────────────────────────────────────────
    // APPLY REPLY PAGINATION METADATA
    // ─────────────────────────────────────────────────────────

    /**
     * Every reply node receives its own pagination cursor
     * and hasMore value.
     *
     * The same applies to direct replies under root comments.
     */

    function applyReplyPagination(parent: CommentNode): void {
      const pagination = replyPaginationMap.get(parent.id);

      const hasMore = pagination?.hasMore ?? false;

      parent.repliesHasMore = hasMore;

      parent.repliesNextCursor = buildReplyCursor(parent.replies, hasMore);
    }

    // Apply pagination metadata to all retrieved replies.
    for (const node of replyNodeMap.values()) {
      applyReplyPagination(node);
    }

    // ─────────────────────────────────────────────────────────
    // BUILD FINAL COMMENT RESPONSE
    // ─────────────────────────────────────────────────────────

    const enriched = rootComments.map((comment) => {
      const rootNode = rootMap.get(comment.id)!;

      const replies = rootNode.replies;

      const rootReplyHasMore = replyRows.some(
        (row) =>
          row.parent_id === comment.id &&
          Number(row.sibling_count) > REPLIES_PAGE_SIZE,
      );

      rootNode.repliesHasMore = rootReplyHasMore;

      rootNode.repliesNextCursor = buildReplyCursor(replies, rootReplyHasMore);

      return rootNode;
    });

    // ─────────────────────────────────────────────────────────
    // ROOT COMMENT NEXT CURSOR
    // ─────────────────────────────────────────────────────────

    const last = rootComments[rootComments.length - 1];

    const nextCursor = hasMore
      ? encodeCursor({
          created_at: new Date(last.created_at).toISOString(),
          id: last.id,
        })
      : null;

    // ─────────────────────────────────────────────────────────
    // FINAL RESPONSE
    // ─────────────────────────────────────────────────────────

    const response = {
      comments: enriched,
      nextCursor,
      hasMore,
    };

    // ─────────────────────────────────────────────────────────
    // REDIS CACHE SET
    // ─────────────────────────────────────────────────────────

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), {
          EX: CACHE_TTL,
        });
      } catch (err) {
        console.error("REDIS SET ERROR:", err);
      }
    }

    return res.json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({
        error: message,
      });
    }

    console.error("[comments] FETCH error:", err);

    return res.status(500).json({
      error: "Fetch failed",
    });
  }
};
