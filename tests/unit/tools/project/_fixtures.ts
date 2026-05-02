// tests/unit/tools/project/_fixtures.ts
//
// Shared stub-graphql helper for the gh.project_* tool tests,
// matching the issue/pr/label fixture shape.

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

// Common project-resolution fixtures used by every project tool
// test (each tool resolves the project ref before the actual op).
export const projectIdResolutionOrgWins = {
  organization: { projectV2: { id: "PVT_kwDO_proj" } },
  user: null,
};

export const projectIdResolutionUserWins = {
  organization: null,
  user: { projectV2: { id: "PVT_kwDO_userproj" } },
};

export const projectIdResolutionNotFound = {
  organization: null,
  user: null,
};
