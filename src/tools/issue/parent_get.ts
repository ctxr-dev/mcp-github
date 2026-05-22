// src/tools/issue/parent_get.ts
//
// `gh.issue_parent_get` — fetch an issue's native parent (the
// read-only counterpart to the sub-issue wiring tool).
// Returns `{ parent: { number, node_id, url, title, state, repo
// } | null }`; null means the issue is a root in the sub-issue
// tree (or has never been wired). Backs the methodology's
// parallel-validation dependency-graph audit at
// `parallel-validation.md:79` and the validators'
// `validate-tree.mjs` parent-chain walk.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

// Issue-ref schema: either pre-resolved `node_id` or
// `(repo, number)`, never both. `oneOf` enforces the divide so
// a mis-shaped input fails fast at the schema boundary rather
// than producing a confusing "issue X not found" downstream.
const inputSchema = {
  type: "object",
  properties: {
    node_id: { type: "string", minLength: 1 },
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
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

const issueRefSchema = {
  type: "object",
  required: ["number", "node_id", "url", "title", "state", "repo"],
  properties: {
    number: { type: "integer" },
    node_id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    state: { type: "string", enum: ["OPEN", "CLOSED"] },
    repo: {
      type: "string",
      description: "`owner/name` of the issue's repo.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["parent"],
  properties: {
    parent: {
      oneOf: [issueRefSchema, { type: "null" }],
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  node_id?: string;
  repo?: string;
  number?: number;
}

interface RawParent {
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

interface ParentSummary {
  number: number;
  node_id: string;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  repo: string;
}

interface Output {
  parent: ParentSummary | null;
}

interface ByRepoResponse {
  repository: {
    issue: { parent: RawParent | null } | null;
  } | null;
}

interface ByIdResponse {
  // Wide on purpose: `node(id)` resolves any GraphQL node type;
  // we narrow on `__typename === "Issue"` at runtime before
  // reading `parent`. Modelling the union with a literal/string
  // discriminant doesn't narrow cleanly because the literal
  // overlaps with `string`, so we keep the field-presence
  // optional and check it after the typename guard.
  node: { __typename: string; parent?: RawParent | null } | null;
}

export function registerIssueParentGetTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_parent_get", {
    description:
      "Fetch an issue's native parent. Returns `{ parent: null }` " +
      "for issues that are roots in the sub-issue tree, or for " +
      "issues never wired into one. Accepts either a pre-resolved " +
      "`node_id` or a `(repo, number)` pair.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.issue_parent_get input",
      );
      let parent: RawParent | null;
      if (typeof args.node_id === "string") {
        const data = await graphql<ByIdResponse>("issue/parent_get_by_id", {
          issueId: args.node_id,
        });
        if (!data.node) {
          throw new Error(
            `mcp-github: gh.issue_parent_get: issue node_id '${args.node_id}' not found`,
          );
        }
        // `node(id)` resolves any GraphQL node, not just Issues.
        // Guard against a node_id that points at a PullRequest /
        // Project / Repository / etc. — without this, GraphQL
        // returns `{ __typename: "..." }` with no `parent` field
        // and `data.node.parent` would be `undefined`, crashing
        // `summariseParent`. Surface a clean error instead.
        if (data.node.__typename !== "Issue") {
          throw new Error(
            `mcp-github: gh.issue_parent_get: node_id '${args.node_id}' is a ${data.node.__typename}, not an Issue`,
          );
        }
        parent = data.node.parent ?? null;
      } else {
        const coords = parseRepoSlug(
          args.repo as string,
          "gh.issue_parent_get input",
        );
        const data = await graphql<ByRepoResponse>("issue/parent_get", {
          owner: coords.owner,
          name: coords.name,
          number: args.number as number,
        });
        if (!data.repository) {
          throw new Error(
            `mcp-github: gh.issue_parent_get: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
          );
        }
        if (!data.repository.issue) {
          throw new Error(
            `mcp-github: gh.issue_parent_get: issue ${coords.owner}/${coords.name}#${args.number ?? "?"} not found`,
          );
        }
        parent = data.repository.issue.parent;
      }
      const out: Output = {
        parent: parent === null ? null : summariseParent(parent),
      };
      return validate<Output>(outputSchema, out, "gh.issue_parent_get output");
    },
  });
}

function summariseParent(raw: RawParent): ParentSummary {
  return {
    number: raw.number,
    node_id: raw.id,
    url: raw.url,
    title: raw.title,
    state: raw.state,
    repo: `${raw.repository.owner.login}/${raw.repository.name}`,
  };
}
