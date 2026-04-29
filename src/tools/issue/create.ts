// src/tools/issue/create.ts
//
// `gh.issue_create` — creates an issue. The MCP-4 input shape is
// gh-CLI-friendly (`repo: "owner/name"` plus label NAMES and
// assignee LOGINS), but GitHub's `createIssue` mutation requires
// the repository's GraphQL node ID, label IDs, and user IDs. So we
// run a prep query (`issue/_repo-context`) first to resolve names
// to IDs, then the mutation. The prep query also doubles as a
// repo-existence check: a missing repo throws cleanly here rather
// than producing a "repositoryId required" error from the mutation.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueSummary,
  type RawIssue,
  issueSummarySchema,
  loadRepoContext,
  parseRepoSlug,
  repoSlugSchema,
  resolveAssigneeIds,
  resolveLabelIds,
  summariseIssue,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "title"],
  properties: {
    repo: repoSlugSchema,
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    labels: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Label names (must already exist on the repo).",
    },
    assignees: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "User logins (must be assignable to this repo).",
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

interface CreateResponse {
  createIssue: { issue: RawIssue };
}

export function registerIssueCreateTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_create", {
    description:
      "Create an issue. `repo` is `owner/name`; `labels` and " +
      "`assignees` are name / login arrays — names that don't " +
      "exist on the repo (or logins that aren't assignable) " +
      "produce a structured error before the mutation runs.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_create input");
      const coords = parseRepoSlug(args.repo, "gh.issue_create input");
      const context = await loadRepoContext(graphql, coords, "gh.issue_create");
      const labelIds = args.labels
        ? resolveLabelIds(context, args.labels, "gh.issue_create")
        : undefined;
      const assigneeIds = args.assignees
        ? resolveAssigneeIds(context, args.assignees, "gh.issue_create")
        : undefined;
      // Build the mutation input object incrementally so unset
      // fields stay absent rather than carrying explicit `undefined`
      // values, which GraphQL serialises as `null` and rejects.
      const input: Record<string, unknown> = {
        repositoryId: context.repositoryId,
        title: args.title,
      };
      if (args.body !== undefined) input.body = args.body;
      if (labelIds !== undefined) input.labelIds = labelIds;
      if (assigneeIds !== undefined) input.assigneeIds = assigneeIds;
      const data = await graphql<CreateResponse>("issue/create", { input });
      const summary = summariseIssue(data.createIssue.issue);
      return validate<IssueSummary>(
        issueSummarySchema,
        summary,
        "gh.issue_create output",
      );
    },
  });
}
