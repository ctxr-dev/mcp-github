// tests/unit/tools/issue/search.test.ts
//
// gh.issue_search: pin the cross-repo `repo` field on each item,
// the total-count pass-through, and the defensive non-Issue
// __typename skip.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueSearchTool } from "../../../../src/tools/issue/search.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawIssue, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_search") throw new Error(`unexpected: ${name}`);
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

test("gh.issue_search: returns items with the cross-repo `repo` field", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/search": {
      search: {
        issueCount: 7,
        pageInfo: { hasNextPage: true, endCursor: "C123" },
        nodes: [
          {
            __typename: "Issue",
            ...sampleRawIssue,
            repository: { nameWithOwner: "owner/repo" },
          },
        ],
      },
    },
  });
  const reg = captureRegistration();
  registerIssueSearchTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    q: "is:issue is:open repo:owner/repo",
    perPage: 30,
  })) as {
    items: Array<{ number: number; repo: string }>;
    total: number;
    hasNextPage: boolean;
    endCursor: string | null;
  };
  assert.equal(out.total, 7);
  assert.equal(out.hasNextPage, true);
  assert.equal(out.endCursor, "C123");
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.repo, "owner/repo");
  assert.equal(calls[0]?.vars.first, 30);
  assert.equal(calls[0]?.vars.q, "is:issue is:open repo:owner/repo");
});

test("gh.issue_search: skips non-Issue search hits defensively", async () => {
  // GitHub's search API can in theory return mixed result types
  // even with `type: ISSUE`; the union schema includes other
  // variants. Assert we don't crash on a stray PullRequest hit.
  const { graphql } = stubGraphqlClient({
    "issue/search": {
      search: {
        issueCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            __typename: "Issue",
            ...sampleRawIssue,
            repository: { nameWithOwner: "owner/repo" },
          },
          { __typename: "PullRequest" },
        ],
      },
    },
  });
  const reg = captureRegistration();
  registerIssueSearchTool(reg.register, graphql);
  const out = (await reg.entry.handler({ q: "anything" })) as {
    items: unknown[];
  };
  assert.equal(out.items.length, 1);
});

test("gh.issue_search: rejects an empty `q` at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/search": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerIssueSearchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ q: "" }),
    /gh\.issue_search input/,
  );
});
