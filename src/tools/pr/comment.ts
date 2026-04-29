// src/tools/pr/comment.ts
//
// `gh.pr_comment` — adds a comment on a PR. Two paths:
//
//   1. Without `in_reply_to`: posts an issue-level comment on the
//      PR (the same surface as `gh pr comment`). Uses AddComment
//      with the PR's GraphQL node ID as the subjectId.
//   2. With `in_reply_to`: posts a reply on a specific review
//      thread. Uses AddPullRequestReviewThreadReply with the
//      thread's node ID; the caller is expected to have looked up
//      the thread ID via the PR-view payload (review threads
//      become accessible there in a later MCP-* PR).
//
// The two paths are different mutations because GitHub treats
// "issue comments" and "review comments" as distinct objects with
// separate node-ID namespaces. The output shape is identical.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  lookupPRNodeId,
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
    in_reply_to: {
      type: "string",
      minLength: 1,
      description:
        "Review-thread node ID (PullRequestReviewThread). When " +
        "supplied, the comment posts as a thread reply rather " +
        "than an issue-level PR comment.",
    },
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
  in_reply_to?: string;
}

interface Output {
  comment_id: string;
  url: string;
}

interface IssueCommentResponse {
  addComment: { commentEdge: { node: { id: string; url: string } } };
}

interface ReplyResponse {
  addPullRequestReviewThreadReply: {
    comment: { id: string; url: string };
  };
}

export function registerPRCommentTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_comment", {
    description:
      "Add a comment on a PR. Without `in_reply_to`, posts an " +
      "issue-level PR comment. With `in_reply_to` (a review-thread " +
      "node ID), posts a reply on that thread. Returns the new " +
      "comment's node ID and HTML url in either case.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_comment input");
      const coords = parseRepoSlug(args.repo, "gh.pr_comment input");
      let result: Output;
      if (args.in_reply_to !== undefined) {
        const data = await graphql<ReplyResponse>("pr/comment-reply", {
          input: {
            pullRequestReviewThreadId: args.in_reply_to,
            body: args.body,
          },
        });
        result = {
          comment_id: data.addPullRequestReviewThreadReply.comment.id,
          url: data.addPullRequestReviewThreadReply.comment.url,
        };
      } else {
        const prId = await lookupPRNodeId(
          graphql,
          coords,
          args.number,
          "gh.pr_comment",
        );
        const data = await graphql<IssueCommentResponse>("pr/comment", {
          input: { subjectId: prId, body: args.body },
        });
        result = {
          comment_id: data.addComment.commentEdge.node.id,
          url: data.addComment.commentEdge.node.url,
        };
      }
      return validate<Output>(outputSchema, result, "gh.pr_comment output");
    },
  });
}
