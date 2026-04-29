// tests/unit/tools/pr/comment.test.ts
//
// gh.pr_comment: pin both the issue-level path (no in_reply_to)
// and the review-thread reply path (in_reply_to set). Different
// mutations under the hood, identical output shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRCommentTool } from "../../../../src/tools/pr/comment.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_comment") throw new Error(`unexpected: ${name}`);
    entry = e;
  };
  return {
    register,
    get entry(): ToolEntry {
      if (!entry) throw new Error("not registered");
      return entry;
    },
  };
}

test("gh.pr_comment: without in_reply_to, looks up the PR and runs AddComment", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_7" } } },
    "pr/comment": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.subjectId, "PR_7");
      assert.equal(input.body, "looks good");
      return {
        addComment: {
          commentEdge: { node: { id: "C_1", url: "https://example/u" } },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPRCommentTool(reg.register, graphql);
  const out = await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    body: "looks good",
  });
  assert.deepEqual(out, { comment_id: "C_1", url: "https://example/u" });
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["pr/_pr-lookup", "pr/comment"],
  );
});

test("gh.pr_comment: with in_reply_to, skips the PR lookup and uses the reply mutation", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/comment-reply": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.pullRequestReviewThreadId, "PRRT_thread");
      assert.equal(input.body, "thread reply");
      return {
        addPullRequestReviewThreadReply: {
          comment: { id: "RC_2", url: "https://example/u2" },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPRCommentTool(reg.register, graphql);
  // Thread-reply shape: in_reply_to + body only, no repo/number.
  // The schema's oneOf disallows the four-field combo so callers
  // can't accidentally mismatch the thread's parent PR with a
  // wrong (repo, number) pair that would silently be ignored.
  const out = await reg.entry.handler({
    body: "thread reply",
    in_reply_to: "PRRT_thread",
  });
  assert.deepEqual(out, { comment_id: "RC_2", url: "https://example/u2" });
  // No PR lookup needed when we have the thread ID.
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["pr/comment-reply"],
  );
});

test("gh.pr_comment: rejects mixing in_reply_to with repo/number", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/comment-reply": () => {
      throw new Error("must not run when input shape is invalid");
    },
  });
  const reg = captureRegistration();
  registerPRCommentTool(reg.register, graphql);
  // Schema's oneOf must reject this combo. The previous shape
  // happily ignored repo + number on the thread-reply path,
  // which masked thread-ID-derivation bugs in the caller.
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      body: "x",
      in_reply_to: "PRRT_thread",
    }),
    /gh\.pr_comment input/,
  );
});

test("gh.pr_comment: rejects bare body without repo/number or in_reply_to", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRCommentTool(reg.register, graphql);
  // body alone matches neither oneOf branch — schema rejects.
  await assert.rejects(
    reg.entry.handler({ body: "x" }),
    /gh\.pr_comment input/,
  );
});

test("gh.pr_comment: rejects empty body at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_7" } } },
    "pr/comment": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerPRCommentTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 7, body: "" }),
    /gh\.pr_comment input/,
  );
});
