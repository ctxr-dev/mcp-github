// src/tools/issue/edit.ts
//
// `gh.issue_edit` — updates an existing issue. Like `create`, the
// MCP-4 surface accepts label NAMES + assignee LOGINS while the
// GraphQL mutation needs IDs, so we run a repo-context query first
// to resolve names. We use the issue's GraphQL node ID (not the
// (repo, number) pair) because UpdateIssue's `id` input requires it.
//
// Semantics: passing `labels` / `assignees` REPLACES the issue's
// current set with the new one. To clear, pass an empty array. To
// leave unchanged, omit the field. Same as `gh issue edit`.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueSummary,
  type RawIssue,
  issueSummarySchema,
  loadRepoContext,
  lookupIssueNodeId,
  parseRepoSlug,
  repoSlugSchema,
  resolveAssigneeIds,
  resolveLabelIds,
  summariseIssue,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    state: {
      type: "string",
      enum: ["OPEN", "CLOSED"],
      description: "OPEN reopens; CLOSED closes (without a reason — use gh.issue_close for that).",
    },
    labels: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Replaces the current label set. [] clears, omitting leaves unchanged.",
    },
    assignees: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Replaces the current assignee set. [] clears, omitting leaves unchanged.",
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  state?: "OPEN" | "CLOSED";
  labels?: string[];
  assignees?: string[];
}

interface EditResponse {
  updateIssue: { issue: RawIssue };
}

export function registerIssueEditTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_edit", {
    description:
      "Update fields on an existing issue. `labels` / `assignees` " +
      "REPLACE the current set when supplied; pass `[]` to clear. " +
      "Omitting a field leaves it unchanged.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_edit input");
      const coords = parseRepoSlug(args.repo, "gh.issue_edit input");
      const issueId = await lookupIssueNodeId(
        graphql,
        coords,
        args.number,
        "gh.issue_edit",
      );
      // Only spin up the repo-context lookup when the caller
      // actually passes label or assignee arrays — view/title/body/
      // state-only edits don't need to walk the repo's name maps.
      let labelIds: string[] | undefined;
      let assigneeIds: string[] | undefined;
      if (args.labels !== undefined || args.assignees !== undefined) {
        const context = await loadRepoContext(graphql, coords, "gh.issue_edit");
        if (args.labels !== undefined) {
          labelIds = resolveLabelIds(context, args.labels, "gh.issue_edit");
        }
        if (args.assignees !== undefined) {
          assigneeIds = resolveAssigneeIds(
            context,
            args.assignees,
            "gh.issue_edit",
          );
        }
      }
      const input: Record<string, unknown> = { id: issueId };
      if (args.title !== undefined) input.title = args.title;
      if (args.body !== undefined) input.body = args.body;
      if (args.state !== undefined) input.state = args.state;
      if (labelIds !== undefined) input.labelIds = labelIds;
      if (assigneeIds !== undefined) input.assigneeIds = assigneeIds;
      const data = await graphql<EditResponse>("issue/edit", { input });
      const summary = summariseIssue(data.updateIssue.issue);
      return validate<IssueSummary>(
        issueSummarySchema,
        summary,
        "gh.issue_edit output",
      );
    },
  });
}
