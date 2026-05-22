// src/tools/issue/set_issue_type.ts
//
// `gh.issue_set_issue_type` — apply a native Issue Type to an
// existing issue via the `updateIssueIssueType` GraphQL mutation.
// Requires `admin:org` (same scope as creating the type via
// `gh.org_issue_type_create`). The methodology calls this right
// after `gh.issue_create` when the optional native Issue Type
// flow is on.
//
// Issue ref accepts either a pre-resolved `node_id` (one query —
// straight to the mutation) or a `(repo, number)` pair (one
// extra GraphQL lookup to resolve the issue's node ID). Sourcing
// the node ID directly from `gh.issue_create`'s `node_id` output
// skips the lookup.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueSummary,
  type RawIssue,
  issueSummarySchema,
  lookupIssueNodeId,
  parseRepoSlug,
  repoSlugSchema,
  summariseIssue,
} from "./_shared.js";

// Issue-ref schema: either pre-resolved `node_id` or
// `(repo, number)`, never both. `oneOf` enforces the divide so
// a mis-shaped input fails fast at the schema boundary.
const issueRefSchema = {
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

const inputSchema = {
  type: "object",
  required: ["issue", "issue_type_id"],
  properties: {
    issue: issueRefSchema,
    issue_type_id: {
      type: "string",
      minLength: 1,
      description:
        "Issue type GraphQL node id (looks like `IT_kw...`). The " +
        "canonical source is `gh.org_issue_type_create`'s `node_id` " +
        "output. Note that `gh.org_issue_types_list` returns the " +
        "REST numeric id, NOT a GraphQL node id — those are not " +
        "interchangeable. Until a dedicated list-by-node-id helper " +
        "lands, capture the node id at create time and cache it " +
        "in your config.",
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
  issue: IssueRef;
  issue_type_id: string;
}

interface SetResponse {
  updateIssueIssueType: {
    issue: RawIssue;
  };
}

export function registerIssueSetIssueTypeTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_set_issue_type", {
    description:
      "Apply a native Issue Type to an existing issue via the " +
      "`updateIssueIssueType` GraphQL mutation. Requires the same " +
      "`admin:org` scope as creating the type. Issue ref accepts " +
      "either a pre-resolved `node_id` (from `gh.issue_create`) or " +
      "a `(repo, number)` pair (one extra round-trip).",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.issue_set_issue_type input",
      );
      const issueId = await resolveIssueId(graphql, args.issue);
      const data = await graphql<SetResponse>("issue/set_issue_type", {
        input: { issueId, issueTypeId: args.issue_type_id },
      });
      const summary = summariseIssue(data.updateIssueIssueType.issue);
      return validate<IssueSummary>(
        issueSummarySchema,
        summary,
        "gh.issue_set_issue_type output",
      );
    },
  });
}

async function resolveIssueId(
  graphql: GraphqlClient,
  ref: IssueRef,
): Promise<string> {
  if (typeof ref.node_id === "string") {
    return ref.node_id;
  }
  if (typeof ref.repo === "string" && typeof ref.number === "number") {
    const coords = parseRepoSlug(ref.repo, "gh.issue_set_issue_type input");
    return lookupIssueNodeId(
      graphql,
      coords,
      ref.number,
      "gh.issue_set_issue_type",
    );
  }
  // Schema oneOf guards this; defensive throw mirrors the
  // sibling pattern in add_sub_issue.
  throw new Error(
    `mcp-github: gh.issue_set_issue_type input: must supply either node_id or repo + number`,
  );
}
