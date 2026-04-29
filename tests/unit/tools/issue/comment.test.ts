// tests/unit/tools/issue/comment.test.ts
//
// gh.issue_comment: pin the lookup → AddComment two-step plus the
// missing-issue and empty-body error paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueCommentTool } from "../../../../src/tools/issue/comment.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_comment") throw new Error(`unexpected: ${name}`);
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

test("gh.issue_comment: looks up issue id, then posts the comment", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_42" } } },
    "issue/comment": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.subjectId, "I_42");
      assert.equal(input.body, "hello world");
      return {
        addComment: {
          commentEdge: {
            node: {
              id: "IC_kwDO_42",
              url: "https://github.com/o/r/issues/42#issuecomment-99",
            },
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueCommentTool(reg.register, graphql);
  const out = await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    body: "hello world",
  });
  assert.deepEqual(out, {
    comment_id: "IC_kwDO_42",
    url: "https://github.com/o/r/issues/42#issuecomment-99",
  });
  assert.equal(calls.length, 2);
});

test("gh.issue_comment: throws when the issue cannot be found", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: null } },
  });
  const reg = captureRegistration();
  registerIssueCommentTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99, body: "x" }),
    /owner\/repo#99 not found/,
  );
});

test("gh.issue_comment: rejects an empty body at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_42" } } },
    "issue/comment": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerIssueCommentTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 42, body: "" }),
    /gh\.issue_comment input/,
  );
});
