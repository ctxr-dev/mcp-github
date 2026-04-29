// src/tools/pr/list.ts
//
// `gh.pr_list` — paginated PR list, optionally filtered by state,
// head ref, base ref, or author. `author` is post-filtered
// client-side because GraphQL `Repository.pullRequests` doesn't
// have an `author` filter; same trade-off as gh.issue_list's
// `assignee`/`since` filters.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type PRSummary,
  type RawPR,
  parseRepoSlug,
  prSummarySchema,
  repoSlugSchema,
  summarisePR,
} from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

const inputSchema = {
  type: "object",
  required: ["repo"],
  properties: {
    repo: repoSlugSchema,
    state: {
      type: "string",
      enum: ["OPEN", "CLOSED", "MERGED", "ALL"],
      description: "Defaults to OPEN.",
    },
    head: {
      type: "string",
      minLength: 1,
      description:
        "Filter by head ref name. Branch name only (e.g. `feat/x`); " +
        "if you pass `owner:branch` (the `gh pr list --head` form), " +
        "the `owner:` prefix is stripped before sending to GraphQL " +
        "because Repository.pullRequests.headRefName matches the " +
        "ref name without an owner qualifier.",
    },
    base: {
      type: "string",
      minLength: 1,
      description: "Filter by base ref name.",
    },
    author: {
      type: "string",
      minLength: 1,
      description: "Filter to PRs opened by this login (post-filter, client-side).",
    },
    perPage: { type: "integer", minimum: 1, maximum: PER_PAGE_MAX },
    after: {
      type: "string",
      minLength: 1,
      description: "Opaque cursor from a previous page's endCursor.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: prSummarySchema },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  state?: "OPEN" | "CLOSED" | "MERGED" | "ALL";
  head?: string;
  base?: string;
  author?: string;
  perPage?: number;
  after?: string;
}

interface Output {
  items: PRSummary[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Response {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawPR[];
    };
  } | null;
}

export function registerPRListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_list", {
    description:
      "List PRs in a repo with optional state / head / base / " +
      "author filters. Returns one page; advance via the returned " +
      "`endCursor`. `author` is post-filtered client-side because " +
      "GraphQL Repository.pullRequests doesn't index it.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_list input");
      const coords = parseRepoSlug(args.repo, "gh.pr_list input");
      const states = mapStateFilter(args.state);
      // Strip an optional `owner:` prefix on `head` so the gh-CLI
      // shape (`--head owner:branch`) keeps working. GraphQL's
      // `headRefName` filter is the bare branch name. Validate
      // post-strip too: `head: "owner:"` and `head: ":branch"`
      // (in the second the prefix is empty) would otherwise send
      // an empty filter that matches nothing.
      const head = args.head ? stripOwnerPrefix(args.head) : null;
      if (head !== null && head.length === 0) {
        throw new Error(
          `mcp-github: gh.pr_list input: head must contain a branch name after the optional 'owner:' prefix, got '${args.head}'`,
        );
      }
      const data = await graphql<Response>("pr/list", {
        owner: coords.owner,
        name: coords.name,
        states,
        headRefName: head,
        baseRefName: args.base ?? null,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
      });
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.pr_list: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      // Filter raw nodes BEFORE summarising. summarisePR builds
      // multiple arrays + walks the status-check rollup, so doing
      // it for items that will be dropped by the author predicate
      // wastes work proportional to the page size.
      const filtered: PRSummary[] = [];
      for (const pr of data.repository.pullRequests.nodes) {
        if (args.author && pr.author?.login !== args.author) continue;
        filtered.push(summarisePR(pr));
      }
      const out: Output = {
        items: filtered,
        hasNextPage: data.repository.pullRequests.pageInfo.hasNextPage,
        endCursor: data.repository.pullRequests.pageInfo.endCursor,
      };
      return validate<Output>(outputSchema, out, "gh.pr_list output");
    },
  });
}

// `ALL` translates to "no filter" (null). Unset defaults to OPEN
// to match `gh pr list` ergonomics; callers who want everything
// pass `state: "ALL"` explicitly.
function mapStateFilter(
  state: Input["state"],
): Array<"OPEN" | "CLOSED" | "MERGED"> | null {
  if (state === "ALL") return null;
  if (state === undefined) return ["OPEN"];
  return [state];
}

// Drop an `owner:` prefix from a head-ref name. `gh pr list`'s
// `--head` accepts `owner:branch` for fork PRs; GraphQL's
// `Repository.pullRequests.headRefName` filter is the branch
// name only. We strip rather than reject so the gh-CLI shape
// keeps working without the caller knowing about this
// boundary. A name with no colon passes through unchanged.
function stripOwnerPrefix(head: string): string {
  const colon = head.indexOf(":");
  if (colon === -1) return head;
  return head.slice(colon + 1);
}
