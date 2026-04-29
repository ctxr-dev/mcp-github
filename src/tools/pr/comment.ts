// src/tools/pr/comment.ts
//
// `gh.pr_comment` — adds a comment on a PR. Two paths:
//
//   1. Without `in_reply_to`: posts an issue-level comment on the
//      PR (the same surface as `gh pr comment`). Uses AddComment
//      with the PR's GraphQL node ID as the subjectId.
//   2. With `in_reply_to`: posts a reply on a specific review
//      thread. Uses AddPullRequestReviewThreadReply with the
//      thread's node ID. v0.1 does not yet surface thread IDs in
//      any of this server's outputs (PRSummary carries only a
//      review_comments_count integer), so the caller must source
//      the thread ID from GitHub directly until a future tool
//      returns it. See input-schema description for details.
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

// Two valid call shapes; `oneOf` enforces the divide so callers
// can't pass `repo + number + in_reply_to` together (they'd
// previously silently flow down the thread-reply path with the
// repo + number pair ignored, which masks bugs in the caller's
// thread-ID derivation).
const inputSchema = {
  type: "object",
  required: ["body"],
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
        "than an issue-level PR comment, and the call SHAPE " +
        "differs: omit `repo` and `number` because the thread ID " +
        "already disambiguates. NOTE: v0.1 does not yet expose " +
        "thread IDs in any of this server's outputs (PRSummary " +
        "carries only review_comments_count); the caller must " +
        "source the ID from GitHub directly until a future tool " +
        "returns it.",
    },
  },
  oneOf: [
    {
      // Issue-level path: needs repo + number, no in_reply_to.
      required: ["repo", "number"],
      not: { required: ["in_reply_to"] },
    },
    {
      // Thread-reply path: needs in_reply_to ONLY. repo + number
      // are deliberately disallowed here because the thread ID
      // already carries enough context — accepting them would
      // create ambiguity if the caller's repo/number didn't
      // match the thread's parent PR.
      required: ["in_reply_to"],
      not: { anyOf: [{ required: ["repo"] }, { required: ["number"] }] },
    },
  ],
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

// The two call shapes are split into a discriminated union so
// the handler narrows correctly without re-checking field
// presence after the runtime validate(). Schema validation
// enforces the actual shape; this type just helps TypeScript
// see the same.
type Input =
  | {
      repo: string;
      number: number;
      body: string;
      in_reply_to?: undefined;
    }
  | {
      in_reply_to: string;
      body: string;
      repo?: undefined;
      number?: undefined;
    };

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
      "Add a comment on a PR. TWO CALL SHAPES, mutually exclusive: " +
      "(a) `{repo, number, body}` posts an issue-level PR comment; " +
      "(b) `{in_reply_to, body}` posts a reply on a review thread " +
      "by its node ID. Passing `repo`/`number` together with " +
      "`in_reply_to` is rejected at schema validation. Returns the " +
      "new comment's node ID and HTML url in either case.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_comment input");
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
        // Schema's oneOf guarantees repo + number are present on
        // this branch, so the parse + lookup never see undefined.
        const coords = parseRepoSlug(args.repo, "gh.pr_comment input");
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
