// tests/unit/tools/issue/edit.test.ts
//
// gh.issue_edit: pin the lazy repo-context lookup (only triggered
// when labels or assignees are passed) and the per-field
// pass-through to the UpdateIssue mutation input.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueEditTool } from "../../../../src/tools/issue/edit.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import {
  sampleRawIssue,
  sampleRepoContextResponse,
  stubGraphqlClient,
} from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_edit") throw new Error(`unexpected: ${name}`);
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

test("gh.issue_edit: title/body-only edits skip the repo-context lookup", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": {
      repository: { issue: { id: "I_target" } },
    },
    "issue/edit": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.id, "I_target");
      assert.equal(input.title, "New title");
      assert.equal(input.body, "New body");
      assert.equal("labelIds" in input, false);
      assert.equal("assigneeIds" in input, false);
      return { updateIssue: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueEditTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    title: "New title",
    body: "New body",
  });
  // Only the issue lookup + the mutation. No repo-context query.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.queryName, "issue/_issue-lookup");
  assert.equal(calls[1]?.queryName, "issue/edit");
});

test("gh.issue_edit: triggers repo-context lookup when labels are passed", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": {
      repository: { issue: { id: "I_target" } },
    },
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/edit": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.deepEqual(input.labelIds, ["LA_bug"]);
      return { updateIssue: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueEditTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    labels: ["bug"],
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.queryName, "issue/_repo-context");
});

test("gh.issue_edit: empty labels array clears the label set", async () => {
  // Passing labels: [] is the documented "clear" semantics; verify
  // the mutation input carries an empty labelIds array (not omitted,
  // not null) so GraphQL applies the clear.
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: { id: "I_target" } } },
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/edit": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.deepEqual(input.labelIds, []);
      return { updateIssue: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueEditTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    labels: [],
  });
});

test("gh.issue_edit: throws when the issue cannot be found", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": { repository: { issue: null } },
  });
  const reg = captureRegistration();
  registerIssueEditTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /owner\/repo#99 not found/,
  );
});
