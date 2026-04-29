// src/tools/issue/list.ts
//
// `gh.issue_list` — paginated list of issues in a repo, optionally
// filtered by state / labels / assignee / since. Output is one
// page; the caller advances through pages via the returned
// `endCursor` (passed back as `after` on the next call).
//
// Note on `assignee` + `since`: GraphQL's `Repository.issues`
// doesn't support these directly. We accept them in the input
// (matching `gh issue list`'s ergonomics) and post-filter the
// returned page client-side. That means the page-size budget is
// "best effort" — a heavy `assignee` filter can produce a small
// page from a large fetch — but the surface stays consistent with
// the gh CLI.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueSummary,
  type RawIssue,
  issueSummarySchema,
  parseRepoSlug,
  repoSlugSchema,
  summariseIssue,
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
      enum: ["OPEN", "CLOSED", "ALL"],
      description: "Defaults to OPEN.",
    },
    labels: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Filter to issues that have ALL of these labels.",
    },
    assignee: {
      type: "string",
      minLength: 1,
      description: "Filter to issues assigned to this login.",
    },
    since: {
      type: "string",
      format: "date-time",
      description: "ISO-8601; only issues updated at-or-after this instant.",
    },
    perPage: {
      type: "integer",
      minimum: 1,
      maximum: PER_PAGE_MAX,
    },
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
    items: { type: "array", items: issueSummarySchema },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  state?: "OPEN" | "CLOSED" | "ALL";
  labels?: string[];
  assignee?: string;
  since?: string;
  perPage?: number;
  after?: string;
}

interface Output {
  items: IssueSummary[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Response {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawIssue[];
    };
  } | null;
}

export function registerIssueListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_list", {
    description:
      "List issues in a repository with optional state / label / " +
      "assignee / since filters. Returns one page; advance with the " +
      "returned `endCursor` (pass as `after` next call). " +
      "`assignee` and `since` are post-filtered client-side because " +
      "GraphQL Repository.issues doesn't index them directly.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_list input");
      const coords = parseRepoSlug(args.repo, "gh.issue_list input");
      const states = mapStateFilter(args.state);
      const data = await graphql<Response>("issue/list", {
        owner: coords.owner,
        name: coords.name,
        states,
        labels: args.labels && args.labels.length > 0 ? args.labels : null,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
      });
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.issue_list: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      // Filter the raw GraphQL nodes BEFORE summarising. Mapping
      // each node through `summariseIssue` allocates new arrays for
      // labels + assignees, so doing it for items that will be
      // dropped wastes work proportional to the page size. Inline
      // checks on the raw shape are cheaper and only the survivors
      // pay the summarisation cost.
      const sinceMs = args.since ? Date.parse(args.since) : NaN;
      const filtered: IssueSummary[] = [];
      for (const issue of data.repository.issues.nodes) {
        if (
          args.assignee &&
          !issue.assignees.nodes.some((a) => a.login === args.assignee)
        ) {
          continue;
        }
        if (Number.isFinite(sinceMs)) {
          const updatedMs = Date.parse(issue.updatedAt);
          if (Number.isFinite(updatedMs) && updatedMs < sinceMs) {
            continue;
          }
        }
        filtered.push(summariseIssue(issue));
      }
      const out: Output = {
        items: filtered,
        hasNextPage: data.repository.issues.pageInfo.hasNextPage,
        endCursor: data.repository.issues.pageInfo.endCursor,
      };
      return validate<Output>(outputSchema, out, "gh.issue_list output");
    },
  });
}

// Map our caller-friendly enum onto the GraphQL `IssueState` shape.
// `ALL` translates to "no filter" (null), which GraphQL interprets
// as both states. Unset defaults to OPEN, matching `gh issue list`
// ergonomics — callers who want every state pass `state: "ALL"`
// explicitly rather than relying on a noisy default.
function mapStateFilter(
  state: Input["state"],
): Array<"OPEN" | "CLOSED"> | null {
  if (state === "ALL") return null;
  if (state === undefined) return ["OPEN"];
  return [state];
}
