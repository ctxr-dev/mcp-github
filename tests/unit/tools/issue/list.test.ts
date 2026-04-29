// tests/unit/tools/issue/list.test.ts
//
// gh.issue_list: pin the page-shape contract (items + hasNextPage
// + endCursor), the state mapping (OPEN/CLOSED/ALL → GraphQL
// IssueState), and the post-fetch client-side filter for `assignee`
// and `since`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueListTool } from "../../../../src/tools/issue/list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawIssue, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_list") throw new Error(`unexpected: ${name}`);
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

test("gh.issue_list: returns items + page info, default state filter is OPEN", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/list": {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [sampleRawIssue],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerIssueListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo" })) as {
    items: Array<{ number: number }>;
    hasNextPage: boolean;
    endCursor: string | null;
  };
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.number, 42);
  assert.equal(out.hasNextPage, false);
  assert.equal(out.endCursor, null);
  // Default state: OPEN only.
  assert.deepEqual(calls[0]?.vars.states, ["OPEN"]);
});

test("gh.issue_list: state=ALL passes a null states filter to GraphQL", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/list": {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerIssueListTool(reg.register, graphql);
  await reg.entry.handler({ repo: "owner/repo", state: "ALL" });
  assert.equal(calls[0]?.vars.states, null);
});

test("gh.issue_list: client-side `assignee` filter drops non-matching items", async () => {
  const fixtureIssues = [
    { ...sampleRawIssue, number: 1 },
    {
      ...sampleRawIssue,
      number: 2,
      assignees: {
        pageInfo: { hasNextPage: false },
        nodes: [{ login: "carol" }],
      },
    },
  ];
  const { graphql } = stubGraphqlClient({
    "issue/list": {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: fixtureIssues,
        },
      },
    },
  });
  const reg = captureRegistration();
  registerIssueListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    assignee: "carol",
  })) as { items: Array<{ number: number }> };
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.number, 2);
});

test("gh.issue_list: client-side `since` filter drops older items", async () => {
  const fixtureIssues = [
    {
      ...sampleRawIssue,
      number: 1,
      updatedAt: "2026-04-01T00:00:00Z",
    },
    {
      ...sampleRawIssue,
      number: 2,
      updatedAt: "2026-04-15T00:00:00Z",
    },
  ];
  const { graphql } = stubGraphqlClient({
    "issue/list": {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: fixtureIssues,
        },
      },
    },
  });
  const reg = captureRegistration();
  registerIssueListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    since: "2026-04-10T00:00:00Z",
  })) as { items: Array<{ number: number }> };
  assert.deepEqual(
    out.items.map((i) => i.number),
    [2],
  );
});

test("gh.issue_list: throws when the repository is not found", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/list": { repository: null },
  });
  const reg = captureRegistration();
  registerIssueListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo" }),
    /repository 'owner\/repo' not found/,
  );
});
