// src/tools/issue/close.ts
//
// `gh.issue_close` — closes an issue with a stated reason
// (`completed` or `not_planned`). Two-step: look up the node ID,
// then run the closeIssue mutation. If a `comment` is supplied, we
// post it BEFORE closing so it lands on the still-open issue and
// authors who watch close events see the comment in context.

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

const inputSchema = {
  type: "object",
  required: ["repo", "number", "reason"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    reason: { type: "string", enum: ["completed", "not_planned"] },
    comment: {
      type: "string",
      minLength: 1,
      description: "Optional closing comment posted before the close.",
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  reason: "completed" | "not_planned";
  comment?: string;
}

interface CloseResponse {
  closeIssue: { issue: RawIssue };
}

interface CommentResponse {
  addComment: { commentEdge: { node: { id: string } } };
}

const REASON_GRAPHQL: Record<Input["reason"], "COMPLETED" | "NOT_PLANNED"> = {
  completed: "COMPLETED",
  not_planned: "NOT_PLANNED",
};

export function registerIssueCloseTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_close", {
    description:
      "Close an issue with a stated reason (completed | not_planned). " +
      "Optionally post a closing comment before the close so watchers " +
      "see the rationale alongside the state change.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_close input");
      const coords = parseRepoSlug(args.repo, "gh.issue_close input");
      const issueId = await lookupIssueNodeId(
        graphql,
        coords,
        args.number,
        "gh.issue_close",
      );
      if (args.comment !== undefined) {
        await graphql<CommentResponse>("issue/comment", {
          input: { subjectId: issueId, body: args.comment },
        });
      }
      const data = await graphql<CloseResponse>("issue/close", {
        input: {
          issueId,
          stateReason: REASON_GRAPHQL[args.reason],
        },
      });
      const summary = summariseIssue(data.closeIssue.issue);
      return validate<IssueSummary>(
        issueSummarySchema,
        summary,
        "gh.issue_close output",
      );
    },
  });
}
