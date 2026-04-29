// tests/unit/tools/pr/_fixtures.ts
//
// Shared fixtures + stub-graphql helpers for the gh.pr_* tool
// tests. Mirrors the issue-domain fixtures in shape; the only
// material differences are the heavier per-PR payload (reviews,
// reviewThreads totalCount, statusCheckRollup).

import type { GraphqlClient } from "../../../../src/graphql/client.ts";

export interface MockedCall {
  queryName: string;
  vars: Record<string, unknown>;
}

export function stubGraphqlClient(
  fixtures: Record<
    string,
    | unknown
    | ((vars: Record<string, unknown>) => unknown | Promise<unknown>)
  >,
): { graphql: GraphqlClient; calls: MockedCall[] } {
  const calls: MockedCall[] = [];
  const graphql = (async (
    queryName: string,
    vars: Record<string, unknown> = {},
  ) => {
    calls.push({ queryName, vars });
    if (!(queryName in fixtures)) {
      throw new Error(
        `tests: stubGraphqlClient saw unmocked queryName: ${queryName}`,
      );
    }
    const entry = fixtures[queryName];
    if (typeof entry === "function") {
      return await (entry as (v: Record<string, unknown>) => unknown)(vars);
    }
    return entry;
  }) as unknown as GraphqlClient;
  return { graphql, calls };
}

// Canonical RawPR shape used across the per-tool tests. Tests
// override fields case-by-case via spread.
export const sampleRawPR = {
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  id: "PR_kwDO_7",
  title: "Sample PR",
  state: "OPEN" as const,
  body: "Sample body",
  baseRefName: "main",
  headRefName: "feat/x",
  isDraft: false,
  mergeable: "MERGEABLE" as const,
  merged: false,
  mergedAt: null,
  mergeCommit: null,
  labels: {
    pageInfo: { hasNextPage: false },
    nodes: [{ name: "enhancement" }],
  },
  assignees: {
    pageInfo: { hasNextPage: false },
    nodes: [{ login: "alice" }],
  },
  author: { login: "bob" },
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-02T00:00:00Z",
  closedAt: null,
  reviews: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { state: "APPROVED" as const, author: { login: "carol" } },
    ],
  },
  reviewThreads: {
    pageInfo: { hasNextPage: false },
    nodes: [{ comments: { totalCount: 3 } }, { comments: { totalCount: 0 } }],
  },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS" as const,
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: "CheckRun" as const,
                  name: "ci/build",
                  conclusion: "SUCCESS" as const,
                  status: "COMPLETED" as const,
                },
                {
                  __typename: "StatusContext" as const,
                  context: "ci/legacy",
                  state: "SUCCESS" as const,
                },
              ],
            },
          },
        },
      },
    ],
  },
};
