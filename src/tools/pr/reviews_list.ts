// src/tools/pr/reviews_list.ts
//
// `gh.pr_reviews_list` — paginated list of a PR's reviews.
// `gh.pr_view` already surfaces a `reviews` array, but caps at
// the first 100 entries; PRs with > 100 reviews (very long-lived
// migration PRs, bot-driven repos, etc.) need real pagination to
// see the tail.
//
// Pagination follows the codebase-wide convention from
// `gh.issue_list` / `gh.pr_list` / `gh.label_list`: input uses
// `perPage` + `after`, output exposes `hasNextPage` + `endCursor`
// at the top level (no `pageInfo` wrapper).
//
// Per-review fields: id, author, state, submitted_at, body (the
// full review-summary text, not truncated), commit_sha (the SHA
// the review was submitted against), and url.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

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
        `Reviews per page (default ${PER_PAGE_DEFAULT}, max ${PER_PAGE_MAX}). ` +
        "Naming matches the other paginated list tools.",
    },
  },
  additionalProperties: false,
} as const;

const reviewSchema = {
  type: "object",
  required: [
    "id",
    "author",
    "state",
    "submitted_at",
    "body",
    "commit_sha",
    "url",
  ],
  properties: {
    id: { type: "string" },
    author: { type: ["string", "null"] },
    state: {
      type: "string",
      enum: ["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"],
    },
    submitted_at: { type: ["string", "null"] },
    body: { type: "string" },
    commit_sha: { type: ["string", "null"] },
    url: { type: "string" },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "total", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: reviewSchema },
    total: {
      type: "integer",
      minimum: 0,
      description: "GraphQL totalCount across all pages.",
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
}

interface RawReview {
  id: string;
  state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
  body: string;
  submittedAt: string | null;
  author: { login: string } | null;
  commit: { oid: string } | null;
  url: string;
}

interface ReviewSummary {
  id: string;
  author: string | null;
  state: RawReview["state"];
  submitted_at: string | null;
  body: string;
  commit_sha: string | null;
  url: string;
}

interface Output {
  items: ReviewSummary[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Response {
  repository: {
    pullRequest: {
      reviews: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawReview[];
      };
    } | null;
  } | null;
}

export function registerPRReviewsListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_reviews_list", {
    description:
      "Paginated list of a PR's reviews — the full history, " +
      "including reviews beyond gh.pr_view's first-100 window. " +
      "Pagination uses `perPage` / `after` on input and " +
      "`items` / `total` / `hasNextPage` / `endCursor` at top " +
      "of output, matching the other list tools. Each entry " +
      "exposes id, author, state, submitted_at, body (full " +
      "summary text, not truncated), commit_sha (the SHA the " +
      "review was submitted against), and url.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.pr_reviews_list input",
      );
      const coords = parseRepoSlug(args.repo, "gh.pr_reviews_list input");
      const data = await graphql<Response>("pr/reviews_list", {
        owner: coords.owner,
        name: coords.name,
        number: args.number,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
      });
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.pr_reviews_list: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      const pr = data.repository.pullRequest;
      if (!pr) {
        throw new Error(
          `mcp-github: gh.pr_reviews_list: PR ${coords.owner}/${coords.name}#${args.number} not found`,
        );
      }
      const out: Output = {
        items: pr.reviews.nodes.map(summariseReview),
        total: pr.reviews.totalCount,
        hasNextPage: pr.reviews.pageInfo.hasNextPage,
        endCursor: pr.reviews.pageInfo.endCursor,
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.pr_reviews_list output",
      );
    },
  });
}

function summariseReview(raw: RawReview): ReviewSummary {
  return {
    id: raw.id,
    author: raw.author?.login ?? null,
    state: raw.state,
    submitted_at: raw.submittedAt,
    body: raw.body,
    commit_sha: raw.commit?.oid ?? null,
    url: raw.url,
  };
}
