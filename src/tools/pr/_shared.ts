// src/tools/pr/_shared.ts
//
// Helpers shared across the six gh.pr_* tools. Mirrors the issue
// domain's _shared.ts in shape: parse repo slug, look up PR node
// IDs, summarise the GraphQL response onto a stable `PRSummary`
// JSON-Schema. The PR shape is heavier than the issue shape
// because PR-view rolls in reviews, review-comments, and
// status-checks summaries.

import type { GraphqlClient } from "../../graphql/client.js";
import { parseRepoSlug as parseIssueRepoSlug, type RepoCoords, repoSlugSchema } from "../issue/_shared.js";

// Re-export the slug parser + JSON-Schema fragment so PR tools
// don't reach across into the issue domain at the call site. The
// underlying logic is identical: `owner/name`.
export type { RepoCoords };
export { repoSlugSchema };
export const parseRepoSlug = parseIssueRepoSlug;

// Lookup-by-(repo, number): returns the PR's GraphQL node ID.
// Used by the three mutations that operate on an existing PR
// (edit, comment, merge).
interface PRLookupResponse {
  repository: {
    pullRequest: { id: string } | null;
  } | null;
}

export async function lookupPRNodeId(
  graphql: GraphqlClient,
  coords: RepoCoords,
  number: number,
  where: string,
): Promise<string> {
  const data = await graphql<PRLookupResponse>("pr/_pr-lookup", {
    owner: coords.owner,
    name: coords.name,
    number,
  });
  // Distinguish "repo missing / no access" from "PR missing", same
  // pattern as the issue domain.
  if (!data.repository) {
    throw new Error(
      `mcp-github: ${where}: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  const id = data.repository.pullRequest?.id;
  if (typeof id !== "string") {
    throw new Error(
      `mcp-github: ${where}: PR ${coords.owner}/${coords.name}#${number} not found`,
    );
  }
  return id;
}

// Repository-context lookup used by gh.pr_create — the
// CreatePullRequestInput requires `repositoryId`, not the
// (owner, name) pair.
interface RepoIdResponse {
  repository: { id: string } | null;
}

export async function lookupRepoNodeId(
  graphql: GraphqlClient,
  coords: RepoCoords,
  where: string,
): Promise<string> {
  const data = await graphql<RepoIdResponse>("pr/_repo-id", {
    owner: coords.owner,
    name: coords.name,
  });
  if (!data.repository) {
    throw new Error(
      `mcp-github: ${where}: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  return data.repository.id;
}

// JSON-Schema-shaped summary returned by the PR tools that
// produce a "full PR payload" output: create, view, edit. The
// list tool returns an array of these. gh.pr_merge does NOT
// return PRSummary — it produces a smaller `{merged, sha, url,
// number}` shape because the merge mutation's response only
// guarantees those fields and a full re-fetch would be wasted
// work.
export interface ReviewSummary {
  author: string | null;
  state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
}

export interface StatusCheck {
  context: string;
  state: "EXPECTED" | "ERROR" | "FAILURE" | "PENDING" | "SUCCESS";
}

export interface PRSummary {
  number: number;
  url: string;
  node_id: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  body: string | null;
  base: string;
  head: string;
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  labels: string[];
  assignees: string[];
  author: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  reviews: ReviewSummary[];
  review_comments_count: number;
  status_checks_state: "EXPECTED" | "ERROR" | "FAILURE" | "PENDING" | "SUCCESS" | null;
  status_checks: StatusCheck[];
}

export const reviewSummarySchema = {
  type: "object",
  required: ["author", "state"],
  properties: {
    author: { type: ["string", "null"] },
    state: {
      type: "string",
      enum: ["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"],
    },
  },
  additionalProperties: false,
} as const;

export const statusCheckSchema = {
  type: "object",
  required: ["context", "state"],
  properties: {
    context: { type: "string" },
    state: {
      type: "string",
      enum: ["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"],
    },
  },
  additionalProperties: false,
} as const;

export const prSummarySchema = {
  type: "object",
  required: [
    "number",
    "url",
    "node_id",
    "title",
    "state",
    "body",
    "base",
    "head",
    "draft",
    "mergeable",
    "merged",
    "merged_at",
    "merge_commit_sha",
    "labels",
    "assignees",
    "author",
    "created_at",
    "updated_at",
    "closed_at",
    "reviews",
    "review_comments_count",
    "status_checks_state",
    "status_checks",
  ],
  properties: {
    number: { type: "integer" },
    url: { type: "string" },
    node_id: { type: "string" },
    title: { type: "string" },
    state: { type: "string", enum: ["OPEN", "CLOSED", "MERGED"] },
    body: { type: ["string", "null"] },
    base: { type: "string" },
    head: { type: "string" },
    draft: { type: "boolean" },
    mergeable: { type: "string", enum: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
    merged: { type: "boolean" },
    merged_at: { type: ["string", "null"] },
    merge_commit_sha: { type: ["string", "null"] },
    labels: { type: "array", items: { type: "string" } },
    assignees: { type: "array", items: { type: "string" } },
    author: { type: ["string", "null"] },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    closed_at: { type: ["string", "null"] },
    reviews: { type: "array", items: reviewSummarySchema },
    review_comments_count: { type: "integer", minimum: 0 },
    status_checks_state: {
      type: ["string", "null"],
      enum: ["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS", null],
    },
    status_checks: { type: "array", items: statusCheckSchema },
  },
  additionalProperties: false,
} as const;

// Shape of a PR returned by GraphQL for the create/view/list/edit
// queries. The truncation flags on labels/assignees/reviews/
// reviewThreads/contexts mirror the issue domain's pattern, so a
// PR with > 100 of any of these surfaces an observable warning
// rather than a silently-partial array.
interface PaginatedNodes<T> {
  pageInfo: { hasNextPage: boolean };
  nodes: T[];
}

export interface RawPR {
  number: number;
  url: string;
  id: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  body: string | null;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  merged: boolean;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  labels: PaginatedNodes<{ name: string }>;
  assignees: PaginatedNodes<{ login: string }>;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  reviews: PaginatedNodes<{
    state: ReviewSummary["state"];
    author: { login: string } | null;
  }>;
  reviewThreads: PaginatedNodes<{
    comments: { totalCount: number };
  }>;
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: StatusCheck["state"];
          contexts: PaginatedNodes<RawCheckOrStatus>;
        } | null;
      };
    }>;
  };
}

type RawCheckOrStatus =
  | {
      __typename: "CheckRun";
      name: string;
      conclusion:
        | "ACTION_REQUIRED"
        | "CANCELLED"
        | "FAILURE"
        | "NEUTRAL"
        | "SKIPPED"
        | "STALE"
        | "STARTUP_FAILURE"
        | "SUCCESS"
        | "TIMED_OUT"
        | null;
      status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "WAITING" | "PENDING" | "REQUESTED";
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: StatusCheck["state"];
    };

export function summarisePR(
  raw: RawPR,
  warn: (msg: string) => void = (msg) =>
    process.stderr.write(`${msg}\n`),
): PRSummary {
  warnIfTruncated(raw, warn);
  const reviews: ReviewSummary[] = raw.reviews.nodes.map((r) => ({
    author: r.author?.login ?? null,
    state: r.state,
  }));
  const reviewCommentsCount = raw.reviewThreads.nodes.reduce(
    (sum, t) => sum + t.comments.totalCount,
    0,
  );
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const statusChecks: StatusCheck[] = rollup
    ? rollup.contexts.nodes.map(normaliseCheckOrStatus)
    : [];
  return {
    number: raw.number,
    url: raw.url,
    node_id: raw.id,
    title: raw.title,
    state: raw.state,
    body: raw.body,
    base: raw.baseRefName,
    head: raw.headRefName,
    draft: raw.isDraft,
    mergeable: raw.mergeable,
    merged: raw.merged,
    merged_at: raw.mergedAt,
    merge_commit_sha: raw.mergeCommit?.oid ?? null,
    labels: raw.labels.nodes.map((n) => n.name),
    assignees: raw.assignees.nodes.map((n) => n.login),
    author: raw.author?.login ?? null,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
    closed_at: raw.closedAt,
    reviews,
    review_comments_count: reviewCommentsCount,
    status_checks_state: rollup?.state ?? null,
    status_checks: statusChecks,
  };
}

function warnIfTruncated(raw: RawPR, warn: (msg: string) => void): void {
  const messages: string[] = [];
  if (raw.labels.pageInfo.hasNextPage) {
    messages.push(`labels (>100)`);
  }
  if (raw.assignees.pageInfo.hasNextPage) {
    messages.push(`assignees (>100)`);
  }
  if (raw.reviews.pageInfo.hasNextPage) {
    messages.push(`reviews (>100)`);
  }
  if (raw.reviewThreads.pageInfo.hasNextPage) {
    messages.push(`review threads (>100)`);
  }
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup;
  if (rollup?.contexts.pageInfo.hasNextPage) {
    messages.push(`status checks (>100)`);
  }
  if (messages.length > 0) {
    warn(
      `mcp-github: PR ${raw.url} has truncated output for: ${messages.join(", ")}; first page only.`,
    );
  }
}

// Map the union shape (CheckRun + StatusContext) onto a flat
// `{ context, state }` pair so consumers don't have to branch on
// __typename. CheckRun.conclusion → state via a small lookup
// table; CheckRun in `IN_PROGRESS` / `QUEUED` etc. without a
// concluded status maps to "PENDING".
function normaliseCheckOrStatus(node: RawCheckOrStatus): StatusCheck {
  if (node.__typename === "CheckRun") {
    return {
      context: node.name,
      state: mapCheckRunConclusion(node.conclusion, node.status),
    };
  }
  return { context: node.context, state: node.state };
}

function mapCheckRunConclusion(
  conclusion: Extract<RawCheckOrStatus, { __typename: "CheckRun" }>["conclusion"],
  status: Extract<RawCheckOrStatus, { __typename: "CheckRun" }>["status"],
): StatusCheck["state"] {
  if (conclusion === "SUCCESS") return "SUCCESS";
  if (conclusion === "NEUTRAL" || conclusion === "SKIPPED") return "SUCCESS";
  if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "STARTUP_FAILURE") {
    return "FAILURE";
  }
  if (conclusion === "CANCELLED" || conclusion === "ACTION_REQUIRED" || conclusion === "STALE") {
    return "ERROR";
  }
  // Conclusion is null until the run finishes; fall back to status.
  if (status === "COMPLETED") return "SUCCESS";
  return "PENDING";
}
