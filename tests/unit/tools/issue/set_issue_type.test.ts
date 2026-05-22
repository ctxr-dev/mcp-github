// tests/unit/tools/issue/set_issue_type.test.ts
//
// gh.issue_set_issue_type: pin the (repo, number) vs node_id
// resolution paths, the updateIssueIssueType mutation input
// shape, and the schema's rejection of mixed input shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueSetIssueTypeTool } from "../../../../src/tools/issue/set_issue_type.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawIssue, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_set_issue_type") {
      throw new Error(`unexpected: ${name}`);
    }
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

test("gh.issue_set_issue_type: node_id passes through → one mutation call", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/set_issue_type": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.issueId, "I_pre");
      assert.equal(input.issueTypeId, "IT_kw_1");
      return { updateIssueIssueType: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueSetIssueTypeTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    issue: { node_id: "I_pre" },
    issue_type_id: "IT_kw_1",
  })) as { number: number };
  assert.equal(out.number, 42);
  assert.equal(calls.length, 1);
});

test("gh.issue_set_issue_type: (repo, number) triggers a node-id lookup first", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": () => ({
      repository: { issue: { id: "I_resolved" } },
    }),
    "issue/set_issue_type": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.issueId, "I_resolved");
      assert.equal(input.issueTypeId, "IT_kw_1");
      return { updateIssueIssueType: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueSetIssueTypeTool(reg.register, graphql);
  await reg.entry.handler({
    issue: { repo: "owner/repo", number: 42 },
    issue_type_id: "IT_kw_1",
  });
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["issue/_issue-lookup", "issue/set_issue_type"],
  );
});

test("gh.issue_set_issue_type: rejects mixing node_id with (repo, number) at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerIssueSetIssueTypeTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      issue: { node_id: "I_x", repo: "owner/repo", number: 42 },
      issue_type_id: "IT_kw_1",
    }),
    /gh\.issue_set_issue_type input/,
  );
});

test("gh.issue_set_issue_type: rejects missing issue_type_id at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerIssueSetIssueTypeTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ issue: { node_id: "I_x" } }),
    /gh\.issue_set_issue_type input/,
  );
});
