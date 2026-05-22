// tests/unit/tools/org/_fixtures.ts
//
// Shared fixtures + stub helpers for the gh.org_* tool tests.
// The org domain mixes REST and GraphQL clients (REST for the
// listing endpoint, GraphQL for the mutations) so this module
// re-exports the workflow tests' `stubAuthedRequest` shape
// alongside the standard graphql stub.

export {
  stubAuthedRequest,
  type RestCall,
  withStatus,
  httpError,
} from "../workflow/_fixtures.ts";

import type { GraphqlClient } from "../../../../src/graphql/client.ts";

export interface MockedGraphqlCall {
  queryName: string;
  vars: Record<string, unknown>;
}

export function stubGraphqlClient(
  fixtures: Record<
    string,
    | unknown
    | ((vars: Record<string, unknown>) => unknown | Promise<unknown>)
  >,
): { graphql: GraphqlClient; calls: MockedGraphqlCall[] } {
  const calls: MockedGraphqlCall[] = [];
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

// Canonical RawIssueType fixture — REST shape from
// `GET /orgs/{org}/issue-types`. Tests override fields by spread.
export const sampleRawIssueType = {
  id: 1001,
  name: "Feature",
  description: "A new capability.",
  color: "green",
  is_enabled: true,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-02T00:00:00Z",
};
