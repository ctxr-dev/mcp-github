// src/tools/issue/sub_issues_list.ts
//
// `gh.issue_sub_issues_list` — paginated list of an issue's
// native sub-issues. Counterpart to `gh.issue_parent_get` for
// the downstream walk. Backs `parallel-validation.md:85`
// (validator checks each child's body cites the parent).
//
// Pagination follows the codebase-wide convention from
// `gh.issue_list` / `gh.pr_list` / `gh.label_list`: input uses
// `perPage` + `after`, output exposes `items` + `total` +
// flat `hasNextPage` + `endCursor` at the top level.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

const inputSchema = {
  type: "object",
  properties: {
    node_id: { type: "string", minLength: 1 },
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    after: {
      type: "string",
      minLength: 1,
      description:
        "Opaque cursor from a previous call's `endCursor`. Omit " +
        "on the first call. Naming matches the other paginated " +
        "list tools (gh.issue_list / gh.pr_list / gh.label_list).",
    },
    perPage: {
      type: "integer",
      minimum: 1,
      maximum: PER_PAGE_MAX,
      description:
        `Children per page (default ${PER_PAGE_DEFAULT}, max ${PER_PAGE_MAX}). ` +
        "Naming matches the other paginated list tools.",
    },
    include_closed: {
      type: "boolean",
      description:
        "Default true: returns every linked child regardless of " +
        "state. Set false to filter out CLOSED children " +
        "client-side; `total` still reflects the GraphQL total " +
        "across open + closed.",
    },
  },
  oneOf: [
    {
      required: ["node_id"],
      not: { anyOf: [{ required: ["repo"] }, { required: ["number"] }] },
    },
    {
      required: ["repo", "number"],
      not: { required: ["node_id"] },
    },
  ],
  additionalProperties: false,
} as const;

const childSchema = {
  type: "object",
  required: ["number", "node_id", "url", "title", "state", "repo"],
  properties: {
    number: { type: "integer" },
    node_id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    state: { type: "string", enum: ["OPEN", "CLOSED"] },
    repo: { type: "string" },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "total", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: childSchema },
    total: {
      type: "integer",
      minimum: 0,
      description:
        "GraphQL totalCount across open + closed children — " +
        "unaffected by client-side `include_closed` filtering.",
    },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  node_id?: string;
  repo?: string;
  number?: number;
  after?: string;
  perPage?: number;
  include_closed?: boolean;
}

interface RawChild {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  repository: {
    owner: { login: string };
    name: string;
  };
}

interface ChildSummary {
  number: number;
  node_id: string;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  repo: string;
}

interface Output {
  items: ChildSummary[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

interface SubIssuesConnection {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawChild[];
}

interface ByRepoResponse {
  repository: {
    issue: { subIssues: SubIssuesConnection } | null;
  } | null;
}

interface ByIdResponse {
  // Wide on purpose: `node(id)` resolves any GraphQL node type;
  // we narrow on `__typename === "Issue"` at runtime before
  // reading `subIssues`. Modelling the union with a literal/string
  // discriminant doesn't narrow cleanly because the literal
  // overlaps with `string`, so we keep the field-presence
  // optional and check it after the typename guard.
  node: { __typename: string; subIssues?: SubIssuesConnection } | null;
}

export function registerIssueSubIssuesListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_sub_issues_list", {
    description:
      "Paginated list of an issue's native sub-issues (the " +
      "downstream side of the sub-issue tree). Accepts either a " +
      "pre-resolved `node_id` or `(repo, number)`. Pagination " +
      "uses `perPage` / `after` on input and `items` / `total` / " +
      "`hasNextPage` / `endCursor` at top of output, matching the " +
      "other list tools. `include_closed` defaults to true; set " +
      "false to drop CLOSED children client-side (`total` " +
      "remains the GraphQL total).",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.issue_sub_issues_list input",
      );
      const subIssues = await fetchConnection(graphql, args);
      const includeClosed = args.include_closed ?? true;
      const filtered = includeClosed
        ? subIssues.nodes
        : subIssues.nodes.filter((n) => n.state !== "CLOSED");
      const out: Output = {
        items: filtered.map(summariseChild),
        total: subIssues.totalCount,
        hasNextPage: subIssues.pageInfo.hasNextPage,
        endCursor: subIssues.pageInfo.endCursor,
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.issue_sub_issues_list output",
      );
    },
  });
}

async function fetchConnection(
  graphql: GraphqlClient,
  args: Input,
): Promise<SubIssuesConnection> {
  const first = args.perPage ?? PER_PAGE_DEFAULT;
  const after = args.after ?? null;
  if (typeof args.node_id === "string") {
    const data = await graphql<ByIdResponse>(
      "issue/sub_issues_list_by_id",
      { issueId: args.node_id, first, after },
    );
    if (!data.node) {
      throw new Error(
        `mcp-github: gh.issue_sub_issues_list: issue node_id '${args.node_id}' not found`,
      );
    }
    // `node(id)` resolves any GraphQL node type; guard against a
    // non-Issue id (PullRequest / Project / etc.). Without this,
    // GraphQL returns `{ __typename: "..." }` and reading
    // `subIssues.nodes` would throw a confusing TypeError.
    if (data.node.__typename !== "Issue") {
      throw new Error(
        `mcp-github: gh.issue_sub_issues_list: node_id '${args.node_id}' is a ${data.node.__typename}, not an Issue`,
      );
    }
    if (!data.node.subIssues) {
      // Defence-in-depth: GraphQL guarantees subIssues is non-null
      // on an Issue, but the typed-narrowing made this field
      // optional. If we ever see it missing, surface a clean
      // error rather than crashing downstream.
      throw new Error(
        `mcp-github: gh.issue_sub_issues_list: unexpected empty subIssues for issue node_id '${args.node_id}'`,
      );
    }
    return data.node.subIssues;
  }
  const coords = parseRepoSlug(
    args.repo as string,
    "gh.issue_sub_issues_list input",
  );
  const data = await graphql<ByRepoResponse>("issue/sub_issues_list", {
    owner: coords.owner,
    name: coords.name,
    number: args.number as number,
    first,
    after,
  });
  if (!data.repository) {
    throw new Error(
      `mcp-github: gh.issue_sub_issues_list: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  if (!data.repository.issue) {
    throw new Error(
      `mcp-github: gh.issue_sub_issues_list: issue ${coords.owner}/${coords.name}#${args.number ?? "?"} not found`,
    );
  }
  return data.repository.issue.subIssues;
}

function summariseChild(raw: RawChild): ChildSummary {
  return {
    number: raw.number,
    node_id: raw.id,
    url: raw.url,
    title: raw.title,
    state: raw.state,
    repo: `${raw.repository.owner.login}/${raw.repository.name}`,
  };
}
