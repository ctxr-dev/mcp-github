// tests/unit/tools/issue/close.test.ts
//
// gh.issue_close: pin the reason mapping (completed → COMPLETED,
// not_planned → NOT_PLANNED), the optional comment-before-close
// flow, and the issue-not-found error path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueCloseTool } from "../../../../src/tools/issue/close.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawIssue, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_close") throw new Error(`unexpected: ${name}`);
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

test("gh.issue_close: maps reason: completed → stateReason: COMPLETED", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_target" } } },
    "issue/close": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.issueId, "I_target");
      assert.equal(input.stateReason, "COMPLETED");
      return {
        closeIssue: {
          issue: { ...sampleRawIssue, state: "CLOSED", closedAt: "2026-04-29T00:00:00Z" },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueCloseTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    reason: "completed",
  })) as { state: string; closed_at: string | null };
  assert.equal(out.state, "CLOSED");
  assert.equal(out.closed_at, "2026-04-29T00:00:00Z");
  assert.equal(calls.length, 2); // lookup + close (no comment)
});

test("gh.issue_close: maps reason: not_planned → stateReason: NOT_PLANNED", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_target" } } },
    "issue/close": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.stateReason, "NOT_PLANNED");
      return { closeIssue: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueCloseTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    reason: "not_planned",
  });
});

test("gh.issue_close: posts the comment BEFORE closing when supplied", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_target" } } },
    "issue/comment": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.subjectId, "I_target");
      assert.equal(input.body, "Closing because foo");
      return { addComment: { commentEdge: { node: { id: "C_1", url: "u" } } } };
    },
    "issue/close": (_vars: Record<string, unknown>) =>
      ({ closeIssue: { issue: sampleRawIssue } }),
  });
  const reg = captureRegistration();
  registerIssueCloseTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    reason: "completed",
    comment: "Closing because foo",
  });
  // Order matters: comment before close so watchers see the
  // rationale alongside the state change in their feed.
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["issue/_issue-lookup", "issue/comment", "issue/close"],
  );
});

test("gh.issue_close: rejects an unknown reason at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_target" } } },
    "issue/close": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerIssueCloseTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 42,
      reason: "wontfix",
    }),
    /gh\.issue_close input/,
  );
});
