// tests/unit/tools/issue/view.test.ts
//
// gh.issue_view: pin the canonical happy-path summary plus the
// error surface for an unknown issue and bad input.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueViewTool } from "../../../../src/tools/issue/view.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient, sampleRawIssue } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_view") {
      throw new Error(`unexpected tool name: ${name}`);
    }
    entry = e;
  };
  return {
    register,
    get entry(): ToolEntry {
      if (!entry) throw new Error("handler was not registered");
      return entry;
    },
  };
}

test("gh.issue_view: maps the GraphQL response onto the canonical IssueSummary", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/view": { repository: { issue: sampleRawIssue } },
  });
  const reg = captureRegistration();
  registerIssueViewTool(reg.register, graphql);
  const out = await reg.entry.handler({ repo: "owner/repo", number: 42 });
  assert.deepEqual(out, {
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    node_id: "I_kwDO_42",
    title: "Sample title",
    state: "OPEN",
    body: "Sample body",
    labels: ["bug", "p1"],
    assignees: ["alice"],
    author: "bob",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-02T00:00:00Z",
    closed_at: null,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.vars, {
    owner: "owner",
    name: "repo",
    number: 42,
  });
});

test("gh.issue_view: throws an issue-not-found error when the repo exists but the issue doesn't", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/view": { repository: { issue: null } },
  });
  const reg = captureRegistration();
  registerIssueViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /issue owner\/repo#99 not found/,
  );
});

test("gh.issue_view: throws a repo-not-found error when the repository is null", async () => {
  // The repo-vs-issue distinction matters for the operator: a typo
  // in the slug should not surface as "issue 99 not found", which
  // would point them at the wrong axis. Pin the message text.
  const { graphql } = stubGraphqlClient({
    "issue/view": { repository: null },
  });
  const reg = captureRegistration();
  registerIssueViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /repository 'owner\/repo' not found or token lacks read access/,
  );
});

test("gh.issue_view: rejects malformed repo slugs at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/view": { repository: { issue: sampleRawIssue } },
  });
  const reg = captureRegistration();
  registerIssueViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "no-slash", number: 1 }),
    /gh\.issue_view input/,
  );
});

test("gh.issue_view: rejects negative or zero issue numbers", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/view": { repository: { issue: sampleRawIssue } },
  });
  const reg = captureRegistration();
  registerIssueViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 0 }),
    /gh\.issue_view input/,
  );
});

test("gh.issue_view: rejects unknown additional properties", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/view": { repository: { issue: sampleRawIssue } },
  });
  const reg = captureRegistration();
  registerIssueViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 1, extra: "boom" }),
    /extra/,
  );
});
