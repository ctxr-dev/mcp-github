// src/auth/octokit.ts
//
// Build the authenticated Octokit clients used by tool handlers.
//
// Two clients are exposed because they cover different needs:
//   - `AuthedGraphql` (`@octokit/graphql`): the canonical GraphQL caller
//     used by every domain tool from MCP-3 onwards.
//   - `AuthedRequest` (`@octokit/request`): used by the auth-health tool
//     (`gh.test_connection`) to read response headers like
//     `x-oauth-scopes`, which `@octokit/graphql` does not surface to its
//     callers because it returns the unwrapped `data` payload.
//
// Both clients embed the same PAT via the `authorization: token …`
// header, matching what `gh` CLI sets for REST + GraphQL requests.

import { graphql } from "@octokit/graphql";
import { request } from "@octokit/request";

export type AuthedGraphql = typeof graphql;
export type AuthedRequest = typeof request;

export function createAuthedGraphql(pat: string): AuthedGraphql {
  return graphql.defaults({
    headers: { authorization: `token ${pat}` },
  });
}

export function createAuthedRequest(pat: string): AuthedRequest {
  return request.defaults({
    headers: { authorization: `token ${pat}` },
  });
}
