// tests/unit/tools/label/_fixtures.ts
//
// Shared fixtures + stub-graphql helper for the gh.label_* tool
// tests. Mirrors the issue/pr domains' fixture shape.

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

export function rawLabel(overrides: Partial<{
  id: string;
  name: string;
  color: string;
  description: string | null;
  url: string;
}> = {}) {
  return {
    id: "LA_default",
    name: "default",
    color: "ffffff",
    description: null,
    url: "https://github.com/owner/repo/labels/default",
    ...overrides,
  };
}
