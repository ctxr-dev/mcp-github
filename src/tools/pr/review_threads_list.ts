// src/tools/pr/review_threads_list.ts
//
// `gh.pr_review_threads_list` — paginated list of a PR's review
// threads (the conversation containers around inline review
// comments). Each thread carries the `id` that
// `gh.pr_review_thread_resolve` needs and a small per-thread
// preview of the latest comments (file path, line, body, author,
// timestamp). The methodology's pr-loop flow drives this in a
// loop: read unresolved threads → address each → call
// `pr_review_thread_resolve` per thread.
//
// Pagination is caller-driven (`cursor: endCursor`). We do NOT
// auto-paginate inside the tool: large PRs can have hundreds of
// threads and the methodology often only cares about the first
// page (the agent fixes the visible set, pushes, and the loop
// repeats). `include_resolved` defaults to false because the
// "resolve same turn" rule (`feedback_pr_thread_resolve_same_turn.md`)
// means the orchestrator usually wants only the unresolved set.
// Filtering is client-side; `totalCount` reflects the GraphQL
// totalCount (all threads), not the filtered length, so the
// caller has an honest signal even when a page has no unresolved
// threads.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

const COMMENTS_PER_THREAD_DEFAULT = 10;
const COMMENTS_PER_THREAD_MAX = 50;

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    cursor: {
      type: "string",
      minLength: 1,
      description:
        "Opaque pagination cursor from a previous call's " +
        "`pageInfo.endCursor`. Omit on the first call.",
    },
    page_size: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description:
        "Threads per page. GitHub caps at 100; we mirror that.",
    },
    comments_per_thread: {
      type: "integer",
      minimum: 1,
      maximum: COMMENTS_PER_THREAD_MAX,
      description:
        "How many comments to surface per thread (default 10, " +
        "max 50). Threads with more than this set " +
        "`comments_truncated: true`; fetch the full set via the " +
        "GitHub API directly if needed.",
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
  required: ["totalCount", "pageInfo", "threads"],
  properties: {
    totalCount: { type: "integer", minimum: 0 },
    pageInfo: {
      type: "object",
      required: ["hasNextPage", "endCursor"],
      properties: {
        hasNextPage: { type: "boolean" },
        endCursor: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    threads: { type: "array", items: threadSchema },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  cursor?: string;
  page_size?: number;
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
  startLine: number | null;
  originalStartLine: number | null;
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
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  threads: ThreadSummary[];
}

export function registerPRReviewThreadsListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_review_threads_list", {
    description:
      "Paginated list of a PR's review threads (the conversation " +
      "containers around inline review comments). Returns the " +
      "thread `id` that `gh.pr_review_thread_resolve` consumes, " +
      "plus a per-thread preview of comments (path, line, author, " +
      "body, timestamp). Caller drives pagination via " +
      "`cursor: endCursor`. `include_resolved` defaults to false " +
      "because the methodology's same-turn-resolve rule means the " +
      "agent usually only cares about open threads — `totalCount` " +
      "still reflects the GraphQL total (all threads).",
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
        first: args.page_size ?? 100,
        after: args.cursor ?? null,
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
      const threads: ThreadSummary[] = filtered.map(summariseThread);
      const out: Output = {
        totalCount: pr.reviewThreads.totalCount,
        pageInfo: pr.reviewThreads.pageInfo,
        threads,
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
