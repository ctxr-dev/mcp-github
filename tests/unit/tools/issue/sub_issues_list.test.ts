// tests/unit/tools/issue/sub_issues_list.test.ts
//
// gh.issue_sub_issues_list: pin the two ref-input paths, the
// include_closed filter, the page_size + cursor pass-through,
// and the not-found error shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueSubIssuesListTool } from "../../../../src/tools/issue/sub_issues_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_sub_issues_list") {
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

function rawChild(overrides: Record<string, unknown> = {}) {
  return {
    id: "I_child",
    number: 10,
    title: "Child",
    url: "https://github.com/owner/repo/issues/10",
    state: "OPEN" as const,
    repository: {
      owner: { login: "owner" },
      name: "repo",
    },
    ...overrides,
  };
}

test("gh.issue_sub_issues_list: (repo, number) → repository.issue.subIssues path with defaults", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/sub_issues_list": (vars: Record<string, unknown>) => {
      assert.equal(vars.first, 100);
      assert.equal(vars.after, null);
      assert.equal(vars.number, 1);
      return {
        repository: {
          issue: {
            subIssues: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: "abc" },
              nodes: [
                rawChild({ id: "I_a", number: 10 }),
                rawChild({ id: "I_b", number: 11 }),
              ],
            },
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueSubIssuesListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 1,
  })) as {
    totalCount: number;
    children: Array<{ number: number; repo: string }>;
  };
  assert.equal(out.totalCount, 2);
  assert.equal(out.children.length, 2);
  assert.equal(out.children[0]?.repo, "owner/repo");
  assert.equal(calls.length, 1);
});

test("gh.issue_sub_issues_list: include_closed=false filters CLOSED children out", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/sub_issues_list": () => ({
      repository: {
        issue: {
          subIssues: {
            totalCount: 3,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              rawChild({ id: "I_open_1", number: 10, state: "OPEN" }),
              rawChild({ id: "I_closed", number: 11, state: "CLOSED" }),
              rawChild({ id: "I_open_2", number: 12, state: "OPEN" }),
            ],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerIssueSubIssuesListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 1,
    include_closed: false,
  })) as {
    totalCount: number;
    children: Array<{ number: number; state: string }>;
  };
  // totalCount stays GraphQL-truth even after filtering.
  assert.equal(out.totalCount, 3);
  assert.equal(out.children.length, 2);
  assert.equal(
    out.children.every((c) => c.state === "OPEN"),
    true,
  );
});

test("gh.issue_sub_issues_list: node_id → node(id).subIssues path", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/sub_issues_list_by_id": (vars: Record<string, unknown>) => {
      assert.equal(vars.issueId, "I_pre");
      return {
        node: {
          subIssues: {
            totalCount: 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueSubIssuesListTool(reg.register, graphql);
  await reg.entry.handler({ node_id: "I_pre" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.queryName, "issue/sub_issues_list_by_id");
});

test("gh.issue_sub_issues_list: cursor + page_size pass through", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/sub_issues_list": (vars: Record<string, unknown>) => {
      assert.equal(vars.first, 25);
      assert.equal(vars.after, "PAGE2");
      return {
        repository: {
          issue: {
            subIssues: {
              totalCount: 0,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueSubIssuesListTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 1,
    page_size: 25,
    cursor: "PAGE2",
  });
});

test("gh.issue_sub_issues_list: rejects page_size > 100 at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerIssueSubIssuesListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 1, page_size: 200 }),
    /gh\.issue_sub_issues_list input/,
  );
});

test("gh.issue_sub_issues_list: repo missing throws repository-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/sub_issues_list": () => ({ repository: null }),
  });
  const reg = captureRegistration();
  registerIssueSubIssuesListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 1 }),
    /repository 'owner\/repo' not found/,
  );
});
