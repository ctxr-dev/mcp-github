// tests/unit/tools/issue/_fixtures.ts
//
// Shared fixtures for the gh.issue_* tool tests. Each test mocks
// the GraphqlClient by name (the loader's queryName argument), so
// fixtures here describe the canonical happy-path response shapes
// for each query the issue tools call.

import type { GraphqlClient } from "../../../../src/graphql/client.ts";

export interface MockedCall {
  queryName: string;
  vars: Record<string, unknown>;
}

// Build a graphql() stub that dispatches by queryName. Each entry
// in `fixtures` is either a value (returned directly) or a
// function (called with the vars). Calls outside the fixture map
// throw — every test must declare every query its handler runs.
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

export const sampleRawIssue = {
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
  id: "I_kwDO_42",
  title: "Sample title",
  state: "OPEN" as const,
  body: "Sample body",
  labels: { nodes: [{ name: "bug" }, { name: "p1" }] },
  assignees: { nodes: [{ login: "alice" }] },
  author: { login: "bob" },
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-02T00:00:00Z",
  closedAt: null,
};

export const sampleRepoContextResponse = {
  repository: {
    id: "R_kwDO_repo",
    labels: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { id: "LA_bug", name: "bug" },
        { id: "LA_p1", name: "p1" },
      ],
    },
    assignableUsers: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { id: "U_alice", login: "alice" },
        { id: "U_bob", login: "bob" },
      ],
    },
  },
};
