// src/tools/issue/add_sub_issue.ts
//
// `gh.issue_add_sub_issue` — wire a child issue under a parent
// via GitHub's `addSubIssue` GraphQL mutation. The mutation
// requires node IDs on both sides; this tool accepts either a
// pre-resolved `node_id` or a `(repo, number)` pair per side and
// resolves the IDs lazily, in parallel where possible, so the
// methodology's plan-to-issues flow can wire the tree using the
// numbers it just captured from `gh.issue_create`.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  lookupIssueNodeId,
  parseRepoSlug,
  repoSlugSchema,
} from "./_shared.js";

// Per-side input shape: EITHER `node_id` OR `(repo, number)`. The
// `oneOf` schema fragment is built once here and reused for both
// `parent` and `child` so the constraint is identical on each
// side.
const issueRefSchema = {
  type: "object",
  properties: {
    node_id: {
      type: "string",
      minLength: 1,
      description:
        "Issue GraphQL node ID. Mutually exclusive with repo + " +
        "number; supply ONE of the two shapes.",
    },
    repo: {
      ...repoSlugSchema,
      description:
        "Repository in the form `owner/name`. Pair with " +
        "`number`. Mutually exclusive with `node_id`.",
    },
    number: {
      type: "integer",
      minimum: 1,
      description: "Issue number. Pair with `repo`.",
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

const inputSchema = {
  type: "object",
  required: ["parent", "child"],
  properties: {
    parent: issueRefSchema,
    child: issueRefSchema,
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["parent", "child"],
  properties: {
    parent: {
      type: "object",
      required: ["number", "node_id"],
      properties: {
        number: { type: "integer" },
        node_id: { type: "string" },
      },
      additionalProperties: false,
    },
    child: {
      type: "object",
      required: ["number", "node_id"],
      properties: {
        number: { type: "integer" },
        node_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface IssueRef {
  node_id?: string;
  repo?: string;
  number?: number;
}

interface Input {
  parent: IssueRef;
  child: IssueRef;
}

interface Output {
  parent: { number: number; node_id: string };
  child: { number: number; node_id: string };
}

interface AddSubIssueResponse {
  addSubIssue: {
    issue: { id: string; number: number };
    subIssue: { id: string; number: number };
  };
}

export function registerIssueAddSubIssueTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_add_sub_issue", {
    description:
      "Wire a child issue under a parent via GitHub's native " +
      "`addSubIssue` GraphQL mutation. Either side accepts a raw " +
      "`node_id` or a `(repo, number)` pair — node IDs are resolved " +
      "lazily when omitted. Idempotent in practice: GitHub returns " +
      "success when the link already exists.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.issue_add_sub_issue input",
      );
      // Run both node-ID resolutions in parallel: the two lookups
      // are independent, and on a plan-to-issues run we'll often
      // be called dozens of times so the parallelism matters.
      const [parentId, childId] = await Promise.all([
        resolveSideId(graphql, args.parent, "parent"),
        resolveSideId(graphql, args.child, "child"),
      ]);
      const data = await graphql<AddSubIssueResponse>(
        "issue/add_sub_issue",
        { input: { issueId: parentId, subIssueId: childId } },
      );
      const out: Output = {
        parent: {
          number: data.addSubIssue.issue.number,
          node_id: data.addSubIssue.issue.id,
        },
        child: {
          number: data.addSubIssue.subIssue.number,
          node_id: data.addSubIssue.subIssue.id,
        },
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.issue_add_sub_issue output",
      );
    },
  });
}

// Resolve one side (parent or child) to a GraphQL node ID. The
// `oneOf` schema above guarantees exactly one of the two shapes
// is present; the `else` branch is defensive against a schema
// drift that ever loosens the constraint.
async function resolveSideId(
  graphql: GraphqlClient,
  ref: IssueRef,
  side: "parent" | "child",
): Promise<string> {
  if (typeof ref.node_id === "string") {
    return ref.node_id;
  }
  if (typeof ref.repo === "string" && typeof ref.number === "number") {
    const coords = parseRepoSlug(
      ref.repo,
      `gh.issue_add_sub_issue ${side}`,
    );
    return lookupIssueNodeId(
      graphql,
      coords,
      ref.number,
      `gh.issue_add_sub_issue ${side}`,
    );
  }
  throw new Error(
    `mcp-github: gh.issue_add_sub_issue ${side}: must supply either node_id or repo + number`,
  );
}
