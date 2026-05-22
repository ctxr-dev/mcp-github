// src/tools/pr/review_threads_list.ts
//
// `gh.pr_review_threads_list` — paginated list of a PR's review
// threads (the conversation containers around inline review
// comments). Each thread carries the GraphQL `id` callers feed
// into GitHub's `resolveReviewThread` mutation, plus a per-
// thread preview of comments (file path, line, body, author,
// timestamp). The methodology's pr-loop flow drives this in a
// loop: read unresolved threads → address each → mark each as
// resolved.
//
// Pagination follows the codebase-wide convention from
// `gh.issue_list` / `gh.pr_list` / `gh.label_list`: input uses
// `perPage` + `after`, output exposes `items` and flat
// `hasNextPage` / `endCursor` at the top level. We also surface
// `total` (the GraphQL totalCount) like `gh.issue_search` does
// — useful because the client-side `include_resolved` filter
// would otherwise hide the unfiltered count, and a long-lived
// PR can accumulate hundreds of threads. Pagination is
// caller-driven; large PRs can have hundreds of threads and the
// methodology often only cares about the first page (the agent
// fixes the visible set, pushes, and the loop repeats).
//
// `include_resolved` defaults to false because the "resolve
// same turn" rule (memory `feedback_pr_thread_resolve_same_turn`)
// means the orchestrator usually wants only the unresolved set.
// Filtering is client-side; `totalCount` reflects the GraphQL
// totalCount (all threads), not the filtered length, so the
// caller has an honest signal even when a page has no
// unresolved threads after filtering.
//
// Comments per thread default to the first 10 (the conversation
// is naturally ordered chronologically; the methodology reads
// the opening comment to decide what to fix, plus a few follow-
// ups for context). Threads with more comments than the cap set
// `comments_truncated: true`; consumers who need the tail can
// query GraphQL directly.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;
const COMMENTS_PER_THREAD_DEFAULT = 10;
const COMMENTS_PER_THREAD_MAX = 50;

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    after: {
      type: "string",
      minLength: 1,
      description:
        "Opaque cursor from a previous call's `endCursor`. Omit " +
        "on the first call. Naming matches `gh.pr_list` / " +
        "`gh.issue_list` / `gh.label_list`.",
    },
    perPage: {
      type: "integer",
      minimum: 1,
      maximum: PER_PAGE_MAX,
      description:
        `Threads per page (default ${PER_PAGE_DEFAULT}, max ${PER_PAGE_MAX}). ` +
        "Naming matches the other paginated list tools.",
    },
    comments_per_thread: {
      type: "integer",
      minimum: 1,
      maximum: COMMENTS_PER_THREAD_MAX,
      description:
        `How many comments to surface per thread (default ${COMMENTS_PER_THREAD_DEFAULT}, ` +
        `max ${COMMENTS_PER_THREAD_MAX}). Comments are returned in chronological order ` +
        "(GraphQL `comments(first:N)`) so the thread's opening message " +
        "is included even when the conversation is long. Threads with " +
        "more comments than the cap set `comments_truncated: true`.",
    },
    include_resolved: {
      type: "boolean",
      description:
        "Default false: filter resolved threads out client-side " +
        "(the methodology's same-turn-resolve rule means the " +
        "agent usually only cares about open threads). Set true " +
        "to return every thread on the page regardless of " +
        "resolution state. `totalCount` is unaffected: it is the " +
        "GraphQL totalCount across resolved + unresolved threads.",
    },
  },
  additionalProperties: false,
} as const;

const commentSchema = {
  type: "object",
  required: ["author", "body", "path", "line", "created_at", "url"],
  properties: {
    author: { type: ["string", "null"] },
    body: { type: "string" },
    path: { type: ["string", "null"] },
    line: { type: ["integer", "null"] },
    created_at: { type: "string" },
    url: { type: "string" },
  },
  additionalProperties: false,
} as const;

const threadSchema = {
  type: "object",
  required: [
    "id",
    "is_resolved",
    "path",
    "line",
    "diff_side",
    "comments_total_count",
    "comments_truncated",
    "comments",
  ],
  properties: {
    id: { type: "string" },
    is_resolved: { type: "boolean" },
    path: { type: ["string", "null"] },
    line: { type: ["integer", "null"] },
    diff_side: {
      type: ["string", "null"],
      enum: ["LEFT", "RIGHT", null],
    },
    comments_total_count: { type: "integer", minimum: 0 },
    comments_truncated: { type: "boolean" },
    comments: { type: "array", items: commentSchema },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "total", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: threadSchema },
    total: {
      type: "integer",
      minimum: 0,
      description:
        "GraphQL totalCount across resolved + unresolved threads — " +
        "unaffected by client-side `include_resolved` filtering.",
    },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  after?: string;
  perPage?: number;
  comments_per_thread?: number;
  include_resolved?: boolean;
}

interface RawComment {
  author: { login: string } | null;
  body: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  createdAt: string;
  url: string;
}

interface RawThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffSide: "LEFT" | "RIGHT" | null;
  comments: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean };
    nodes: RawComment[];
  };
}

interface Response {
  repository: {
    pullRequest: {
      reviewThreads: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawThread[];
      };
    } | null;
  } | null;
}

interface CommentSummary {
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  created_at: string;
  url: string;
}

interface ThreadSummary {
  id: string;
  is_resolved: boolean;
  path: string | null;
  line: number | null;
  diff_side: "LEFT" | "RIGHT" | null;
  comments_total_count: number;
  comments_truncated: boolean;
  comments: CommentSummary[];
}

interface Output {
  items: ThreadSummary[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

export function registerPRReviewThreadsListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_review_threads_list", {
    description:
      "Paginated list of a PR's review threads (the conversation " +
      "containers around inline review comments). Returns each " +
      "thread's GraphQL `id` (suitable for `resolveReviewThread`) " +
      "plus a per-thread preview of comments (path, line, author, " +
      "body, timestamp). Pagination uses `perPage` / `after` on " +
      "input and the flat `hasNextPage` / `endCursor` shape on " +
      "output, matching the other list tools; we also surface " +
      "`total` (the GraphQL totalCount) like `gh.issue_search` " +
      "does, since the client-side `include_resolved` filter " +
      "would otherwise hide the unfiltered count. " +
      "`include_resolved` defaults to false because the " +
      "methodology's same-turn-resolve rule means the agent " +
      "usually only cares about open threads.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.pr_review_threads_list input",
      );
      const coords = parseRepoSlug(
        args.repo,
        "gh.pr_review_threads_list input",
      );
      const data = await graphql<Response>("pr/review_threads_list", {
        owner: coords.owner,
        name: coords.name,
        number: args.number,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
        commentsFirst:
          args.comments_per_thread ?? COMMENTS_PER_THREAD_DEFAULT,
      });
      // Same "repo vs PR missing" disambiguation as gh.pr_view.
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.pr_review_threads_list: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      const pr = data.repository.pullRequest;
      if (!pr) {
        throw new Error(
          `mcp-github: gh.pr_review_threads_list: PR ${coords.owner}/${coords.name}#${args.number} not found`,
        );
      }
      const includeResolved = args.include_resolved ?? false;
      const filtered = includeResolved
        ? pr.reviewThreads.nodes
        : pr.reviewThreads.nodes.filter((n) => !n.isResolved);
      const out: Output = {
        items: filtered.map(summariseThread),
        total: pr.reviewThreads.totalCount,
        hasNextPage: pr.reviewThreads.pageInfo.hasNextPage,
        endCursor: pr.reviewThreads.pageInfo.endCursor,
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.pr_review_threads_list output",
      );
    },
  });
}

// Map one raw thread onto the summarised shape. Line numbers fall
// back to `originalLine` when GitHub reports a null `line` (this
// happens for outdated threads where the targeted line no longer
// exists on the diff). The caller still gets a positional signal
// rather than a bare null.
function summariseThread(raw: RawThread): ThreadSummary {
  return {
    id: raw.id,
    is_resolved: raw.isResolved,
    path: raw.path,
    line: raw.line ?? raw.originalLine,
    diff_side: raw.diffSide,
    comments_total_count: raw.comments.totalCount,
    comments_truncated: raw.comments.pageInfo.hasNextPage,
    comments: raw.comments.nodes.map(summariseComment),
  };
}

function summariseComment(raw: RawComment): CommentSummary {
  return {
    author: raw.author?.login ?? null,
    body: raw.body,
    path: raw.path,
    line: raw.line ?? raw.originalLine,
    created_at: raw.createdAt,
    url: raw.url,
  };
}
