// tests/unit/tools/pr/review_threads_list.test.ts
//
// gh.pr_review_threads_list: pin the default-unresolved filter,
// the after/perPage pass-through, the comments_per_thread
// behaviour incl. truncation, the top-level pagination output
// shape (hasNextPage/endCursor at the root, matching the other
// list tools), and the not-found error shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRReviewThreadsListTool } from "../../../../src/tools/pr/review_threads_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_review_threads_list") {
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

function rawThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "RT_1",
    isResolved: false,
    path: "src/foo.ts",
    line: 42,
    originalLine: 42,
    diffSide: "RIGHT" as const,
    comments: {
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: "alice" },
          body: "nit: rename this",
          path: "src/foo.ts",
          line: 42,
          originalLine: 42,
          createdAt: "2026-04-01T00:00:00Z",
          url: "https://github.com/owner/repo/pull/7#discussion_r1",
        },
      ],
    },
    ...overrides,
  };
}

test("gh.pr_review_threads_list: default include_resolved=false filters resolved out", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/review_threads_list": (vars: Record<string, unknown>) => {
      // Defaults: first=100, after=null, commentsFirst=10.
      assert.equal(vars.first, 100);
      assert.equal(vars.after, null);
      assert.equal(vars.commentsFirst, 10);
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: 3,
              pageInfo: { hasNextPage: false, endCursor: "Y3Vy" },
              nodes: [
                rawThread({ id: "RT_open_1", isResolved: false }),
                rawThread({ id: "RT_resolved", isResolved: true }),
                rawThread({ id: "RT_open_2", isResolved: false }),
              ],
            },
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as {
    total: number;
    hasNextPage: boolean;
    endCursor: string | null;
    threads: Array<{ id: string }>;
  };
  // total reflects the GraphQL totalCount (3), not the filtered
  // length (2) — caller still sees there's more than the
  // filter pass-through.
  assert.equal(out.total, 3);
  assert.equal(out.hasNextPage, false);
  assert.equal(out.endCursor, "Y3Vy");
  assert.equal(out.threads.length, 2);
  assert.deepEqual(
    out.threads.map((t) => t.id),
    ["RT_open_1", "RT_open_2"],
  );
  assert.equal(calls.length, 1);
});

test("gh.pr_review_threads_list: include_resolved=true returns every thread", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              rawThread({ id: "RT_open", isResolved: false }),
              rawThread({ id: "RT_resolved", isResolved: true }),
            ],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    include_resolved: true,
  })) as { threads: Array<{ id: string; is_resolved: boolean }> };
  assert.deepEqual(
    out.threads.map((t) => ({ id: t.id, is_resolved: t.is_resolved })),
    [
      { id: "RT_open", is_resolved: false },
      { id: "RT_resolved", is_resolved: true },
    ],
  );
});

test("gh.pr_review_threads_list: after + perPage + comments_per_thread pass through to GraphQL vars", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": (vars: Record<string, unknown>) => {
      assert.equal(vars.first, 25);
      assert.equal(vars.after, "PAGE2_CURSOR");
      assert.equal(vars.commentsFirst, 3);
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
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
  registerPRReviewThreadsListTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    perPage: 25,
    after: "PAGE2_CURSOR",
    comments_per_thread: 3,
  });
});

test("gh.pr_review_threads_list: hasNextPage + endCursor surface at the top of the output", async () => {
  // Pin the pagination output contract that other list tools also
  // follow (flat hasNextPage/endCursor, not nested under pageInfo).
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: 250,
            pageInfo: { hasNextPage: true, endCursor: "NEXT_CURSOR" },
            nodes: [],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as {
    total: number;
    hasNextPage: boolean;
    endCursor: string | null;
  };
  assert.equal(out.total, 250);
  assert.equal(out.hasNextPage, true);
  assert.equal(out.endCursor, "NEXT_CURSOR");
});

test("gh.pr_review_threads_list: comments_truncated=true when the per-thread comment page has more results", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              rawThread({
                id: "RT_chatty",
                comments: {
                  totalCount: 25,
                  pageInfo: { hasNextPage: true },
                  nodes: rawThread().comments.nodes,
                },
              }),
            ],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as {
    threads: Array<{
      comments_truncated: boolean;
      comments_total_count: number;
    }>;
  };
  assert.equal(out.threads.length, 1);
  assert.equal(out.threads[0]?.comments_truncated, true);
  assert.equal(out.threads[0]?.comments_total_count, 25);
});

test("gh.pr_review_threads_list: outdated thread (null line) falls back to originalLine", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              rawThread({
                line: null,
                originalLine: 15,
                comments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      author: { login: "alice" },
                      body: "outdated",
                      path: "src/foo.ts",
                      line: null,
                      originalLine: 15,
                      createdAt: "2026-04-01T00:00:00Z",
                      url: "https://github.com/owner/repo/pull/7#discussion_r1",
                    },
                  ],
                },
              }),
            ],
          },
        },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as { threads: Array<{ line: number | null; comments: Array<{ line: number | null }> }> };
  assert.equal(out.threads[0]?.line, 15);
  assert.equal(out.threads[0]?.comments[0]?.line, 15);
});

test("gh.pr_review_threads_list: repo missing throws repository-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": () => ({ repository: null }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 7 }),
    /repository 'owner\/repo' not found/,
  );
});

test("gh.pr_review_threads_list: PR missing throws PR-shaped error", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_threads_list": () => ({
      repository: { pullRequest: null },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /PR owner\/repo#99 not found/,
  );
});

test("gh.pr_review_threads_list: rejects perPage > 100 at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 7, perPage: 200 }),
    /gh\.pr_review_threads_list input/,
  );
});

test("gh.pr_review_threads_list: rejects comments_per_thread > 50 at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewThreadsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      comments_per_thread: 100,
    }),
    /gh\.pr_review_threads_list input/,
  );
});
