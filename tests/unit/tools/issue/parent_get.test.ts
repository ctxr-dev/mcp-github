// tests/unit/tools/issue/parent_get.test.ts
//
// gh.issue_parent_get: pin both ref-input paths (node_id vs
// (repo, number)), the null-parent passthrough for root issues,
// the cross-repo summary shape, and the schema rejection of
// mixed input.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueParentGetTool } from "../../../../src/tools/issue/parent_get.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_parent_get") throw new Error(`unexpected: ${name}`);
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

const sampleRawParent = {
  id: "I_parent",
  number: 1,
  title: "Parent epic",
  url: "https://github.com/owner/repo/issues/1",
  state: "OPEN" as const,
  repository: {
    owner: { login: "owner" },
    name: "repo",
  },
};

test("gh.issue_parent_get: (repo, number) → repository.issue.parent path", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/parent_get": (vars: Record<string, unknown>) => {
      assert.equal(vars.owner, "owner");
      assert.equal(vars.name, "repo");
      assert.equal(vars.number, 42);
      return {
        repository: { issue: { parent: sampleRawParent } },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
  })) as { parent: { number: number; repo: string; node_id: string } | null };
  assert.deepEqual(out.parent, {
    number: 1,
    node_id: "I_parent",
    url: "https://github.com/owner/repo/issues/1",
    title: "Parent epic",
    state: "OPEN",
    repo: "owner/repo",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.queryName, "issue/parent_get");
});

test("gh.issue_parent_get: node_id → node(id) path (no repo lookup)", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/parent_get_by_id": (vars: Record<string, unknown>) => {
      assert.equal(vars.issueId, "I_pre");
      return {
        node: { __typename: "Issue", parent: sampleRawParent },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  await reg.entry.handler({ node_id: "I_pre" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.queryName, "issue/parent_get_by_id");
});

test("gh.issue_parent_get: node_id pointing at a non-Issue surfaces a typed error", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/parent_get_by_id": () => ({
      node: { __typename: "PullRequest" },
    }),
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ node_id: "PR_x" }),
    /is a PullRequest, not an Issue/,
  );
});

test("gh.issue_parent_get: returns parent: null for a root issue", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/parent_get": () => ({
      repository: { issue: { parent: null } },
    }),
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 1,
  })) as { parent: unknown };
  assert.equal(out.parent, null);
});

test("gh.issue_parent_get: cross-repo parent surfaces with the parent's own repo string", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/parent_get": () => ({
      repository: {
        issue: {
          parent: {
            ...sampleRawParent,
            repository: { owner: { login: "other-org" }, name: "other-repo" },
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
  })) as { parent: { repo: string } | null };
  assert.equal(out.parent?.repo, "other-org/other-repo");
});

test("gh.issue_parent_get: repo missing throws repository-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/parent_get": () => ({ repository: null }),
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 1 }),
    /repository 'owner\/repo' not found/,
  );
});

test("gh.issue_parent_get: issue missing throws issue-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/parent_get": () => ({ repository: { issue: null } }),
  });
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /issue owner\/repo#99 not found/,
  );
});

test("gh.issue_parent_get: rejects mixed (node_id + repo) at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerIssueParentGetTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ node_id: "I_x", repo: "owner/repo", number: 1 }),
    /gh\.issue_parent_get input/,
  );
});
