// src/tools/issue/search.ts
//
// `gh.issue_search` — runs a GitHub search query (`type: ISSUE`)
// and returns a paginated result page. Output items extend the
// canonical `IssueSummary` shape with a `repo` field
// (`owner/name`) so cross-repo searches are usable without an
// extra round-trip to look up which repo each hit belongs to.
//
// The search query syntax is GitHub's standard one (e.g.
// `is:issue is:open repo:foo/bar label:bug`). We pass it through
// verbatim; the caller is responsible for shaping it correctly.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueSummary,
  type RawIssue,
  issueSummarySchema,
  summariseIssue,
} from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

const inputSchema = {
  type: "object",
  required: ["q"],
  properties: {
    q: {
      type: "string",
      minLength: 1,
      description:
        "GitHub search query, e.g. `is:issue is:open repo:foo/bar label:bug`.",
    },
    perPage: {
      type: "integer",
      minimum: 1,
      maximum: PER_PAGE_MAX,
    },
    after: {
      type: "string",
      description: "Opaque cursor from a previous page's endCursor.",
    },
  },
  additionalProperties: false,
} as const;

const itemSchema = {
  ...issueSummarySchema,
  required: [...issueSummarySchema.required, "repo"],
  properties: {
    ...issueSummarySchema.properties,
    repo: { type: "string", description: "owner/name of the issue's repo" },
  },
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "total", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: itemSchema },
    total: {
      type: "integer",
      description: "Total matches across all pages (search.issueCount).",
    },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  q: string;
  perPage?: number;
  after?: string;
}

interface RawSearchHit extends RawIssue {
  __typename: "Issue";
  repository: { nameWithOwner: string };
}

interface RawNonIssueHit {
  __typename: string;
}

interface Response {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<RawSearchHit | RawNonIssueHit>;
  };
}

interface SearchItem extends IssueSummary {
  repo: string;
}

interface Output {
  items: SearchItem[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

export function registerIssueSearchTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_search", {
    description:
      "Search issues across GitHub via the standard query syntax. " +
      "Returns paginated results carrying the canonical issue shape " +
      "plus a `repo` field for cross-repo hits. Total match count " +
      "is in `total`.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_search input");
      const data = await graphql<Response>("issue/search", {
        q: args.q,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
      });
      const items: SearchItem[] = [];
      for (const node of data.search.nodes) {
        // The `type: ISSUE` filter means non-Issue hits shouldn't
        // appear, but the GraphQL union type is `SearchResultItem`
        // and other variants are theoretically possible. Skip them
        // defensively rather than crashing on a missing field.
        if (node.__typename !== "Issue") continue;
        const issue = node as RawSearchHit;
        items.push({
          ...summariseIssue(issue),
          repo: issue.repository.nameWithOwner,
        });
      }
      const out: Output = {
        items,
        total: data.search.issueCount,
        hasNextPage: data.search.pageInfo.hasNextPage,
        endCursor: data.search.pageInfo.endCursor,
      };
      return validate<Output>(outputSchema, out, "gh.issue_search output");
    },
  });
}
