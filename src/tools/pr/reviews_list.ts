// src/tools/pr/reviews_list.ts
//
// `gh.pr_reviews_list` — paginated list of a PR's reviews.
// `gh.pr_view` already surfaces a `reviews` array, but caps at
// the first 100 entries; PRs with > 100 reviews (very long-lived
// migration PRs, bot-driven repos, etc.) need real pagination to
// see the tail. Caller drives pagination via `cursor: endCursor`.
//
// Per-review fields include `submitted_at`, `commit_oid` (the
// HEAD the review was submitted against), and a short `body`
// preview so consumers can tell which review was leaving the
// inline comments rolled up in `gh.pr_review_threads_list`.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    cursor: { type: "string", minLength: 1 },
    page_size: { type: "integer", minimum: 1, maximum: 100 },
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
    "commit_oid",
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
    commit_oid: { type: ["string", "null"] },
    url: { type: "string" },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["totalCount", "pageInfo", "reviews"],
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
    reviews: { type: "array", items: reviewSchema },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  cursor?: string;
  page_size?: number;
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
  commit_oid: string | null;
  url: string;
}

interface Output {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  reviews: ReviewSummary[];
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
      "Each entry exposes the review id, author, state, " +
      "submitted_at, body, commit_oid (the SHA the review was " +
      "submitted against), and url. Caller drives pagination via " +
      "`cursor: endCursor`.",
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
        first: args.page_size ?? 100,
        after: args.cursor ?? null,
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
        totalCount: pr.reviews.totalCount,
        pageInfo: pr.reviews.pageInfo,
        reviews: pr.reviews.nodes.map(summariseReview),
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
    commit_oid: raw.commit?.oid ?? null,
    url: raw.url,
  };
}
