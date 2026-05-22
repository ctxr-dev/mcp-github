// tests/unit/tools/pr/reviews_list.test.ts
//
// gh.pr_reviews_list: pin the GraphQL → summary mapping (incl.
// commit_sha + submitted_at), the after / perPage input naming,
// the top-level pagination output (hasNextPage + endCursor at
// the root, matching the other list tools), and the not-found
// error shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRReviewsListTool } from "../../../../src/tools/pr/reviews_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_reviews_list") throw new Error(`unexpected: ${name}`);
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

function rawReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "PRR_1",
    state: "APPROVED" as const,
    body: "LGTM",
    submittedAt: "2026-04-02T01:00:00Z",
    author: { login: "alice" },
    commit: { oid: "deadbeef" },
    url: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
    ...overrides,
  };
}

test("gh.pr_reviews_list: maps a full GraphQL response onto the canonical summary", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/reviews_list": (vars: Record<string, unknown>) => {
      assert.equal(vars.first, 100);
      assert.equal(vars.after, null);
      return {
        repository: {
          pullRequest: {
            reviews: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: "abc" },
              nodes: [rawReview()],
            },
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPRReviewsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as {
    total: number;
    hasNextPage: boolean;
    endCursor: string | null;
    items: Array<{
      id: string;
      author: string | null;
      state: string;
      submitted_at: string | null;
      commit_sha: string | null;
      body: string;
      url: string;
    }>;
  };
  assert.equal(out.total, 1);
  assert.equal(out.hasNextPage, false);
  assert.equal(out.endCursor, "abc");
  assert.deepEqual(out.items[0], {
    id: "PRR_1",
    author: "alice",
    state: "APPROVED",
    submitted_at: "2026-04-02T01:00:00Z",
    body: "LGTM",
    commit_sha: "deadbeef",
    url: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
  });
  assert.equal(calls.length, 1);
});

test("gh.pr_reviews_list: after + perPage pass through", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/reviews_list": (vars: Record<string, unknown>) => {
      assert.equal(vars.first, 25);
      assert.equal(vars.after, "PAGE2");
      return {
        repository: {
          pullRequest: {
            reviews: {
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
  registerPRReviewsListTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    perPage: 25,
    after: "PAGE2",
  });
});

test("gh.pr_reviews_list: hasNextPage + endCursor surface at the top of the output", async () => {
  // Pin the pagination output contract (flat hasNextPage/endCursor,
  // not nested under pageInfo) to match the other list tools.
  const { graphql } = stubGraphqlClient({
    "pr/reviews_list": () => ({
      repository: {
        pullRequest: {
          reviews: {
            totalCount: 500,
            pageInfo: { hasNextPage: true, endCursor: "PAGE_2_CURSOR" },
            nodes: [],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as { total: number; hasNextPage: boolean; endCursor: string | null };
  assert.equal(out.total, 500);
  assert.equal(out.hasNextPage, true);
  assert.equal(out.endCursor, "PAGE_2_CURSOR");
});

test("gh.pr_reviews_list: PENDING review surfaces submitted_at: null + commit_sha: null", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/reviews_list": () => ({
      repository: {
        pullRequest: {
          reviews: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              rawReview({
                state: "PENDING",
                submittedAt: null,
                commit: null,
                author: null,
              }),
            ],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as {
    items: Array<{
      author: string | null;
      submitted_at: string | null;
      commit_sha: string | null;
      state: string;
    }>;
  };
  assert.equal(out.items[0]?.state, "PENDING");
  assert.equal(out.items[0]?.submitted_at, null);
  assert.equal(out.items[0]?.commit_sha, null);
  assert.equal(out.items[0]?.author, null);
});

test("gh.pr_reviews_list: repo missing throws repository-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/reviews_list": () => ({ repository: null }),
  });
  const reg = captureRegistration();
  registerPRReviewsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 7 }),
    /repository 'owner\/repo' not found/,
  );
});

test("gh.pr_reviews_list: PR missing throws PR-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/reviews_list": () => ({
      repository: { pullRequest: null },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /PR owner\/repo#99 not found/,
  );
});

test("gh.pr_reviews_list: rejects perPage > 100 at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 7, perPage: 200 }),
    /gh\.pr_reviews_list input/,
  );
});
