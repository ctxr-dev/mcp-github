// src/tools/issue/comment.ts
//
// `gh.issue_comment` — adds a comment to an existing issue.
// Two-step: look up the issue's GraphQL node ID by repo + number,
// then run the AddComment mutation against that ID. The two-step
// flow is necessary because AddComment's `subjectId` requires a
// node ID, not a (repo, number) pair.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  lookupIssueNodeId,
  parseRepoSlug,
  repoSlugSchema,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "number", "body"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["comment_id", "url"],
  properties: {
    comment_id: { type: "string" },
    url: { type: "string" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  body: string;
}

interface Output {
  comment_id: string;
  url: string;
}

interface CommentResponse {
  addComment: {
    commentEdge: {
      node: { id: string; url: string };
    };
  };
}

export function registerIssueCommentTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_comment", {
    description:
      "Add a comment to an issue. Returns the new comment's node ID " +
      "and HTML url.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_comment input");
      const coords = parseRepoSlug(args.repo, "gh.issue_comment input");
      const issueId = await lookupIssueNodeId(
        graphql,
        coords,
        args.number,
        "gh.issue_comment",
      );
      const data = await graphql<CommentResponse>("issue/comment", {
        input: {
          subjectId: issueId,
          body: args.body,
        },
      });
      const out: Output = {
        comment_id: data.addComment.commentEdge.node.id,
        url: data.addComment.commentEdge.node.url,
      };
      return validate<Output>(outputSchema, out, "gh.issue_comment output");
    },
  });
}
