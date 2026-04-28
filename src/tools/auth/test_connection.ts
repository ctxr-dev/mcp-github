// src/tools/auth/test_connection.ts
//
// `gh.test_connection` — verifies auth health by issuing a minimal
// `{ viewer { login } }` GraphQL query and reading the OAuth scopes
// from the response headers. Returns `{ login, scopes }` on success.
//
// Why a separate tool rather than wiring this into server bootstrap:
// at v0.1 we want the server to start cleanly even when the PAT is
// scope-limited, so callers can still discover the tool surface and
// then explicitly probe auth via this tool. Crashing on startup would
// leave consumers with no signal beyond "process exited".
//
// Why we go through `@octokit/request` (POST /graphql) here rather than
// the higher-level `@octokit/graphql` client: `@octokit/graphql`
// unwraps and returns just the `data` field, dropping response headers.
// Scopes live in the `x-oauth-scopes` header, so we need the raw
// response. From MCP-3 onwards every other tool uses the GraphQL
// client; this one is the deliberate exception.

import { RequestError } from "@octokit/request-error";
import type { AuthedRequest } from "../../auth/octokit.js";
import { registerTool } from "../../server.js";

const VIEWER_QUERY = "query { viewer { login } }";

export interface TestConnectionResult {
  login: string;
  scopes: string[];
}

interface ViewerGraphqlPayload {
  data?: { viewer?: { login?: string } };
  errors?: Array<{ message?: string }>;
}

// Exposed (rather than registered at module-import time) so the server
// can pass in the resolved authed client. Tests can call `testConnection`
// directly with a synthetic `AuthedRequest`, and the full registration
// path is exercised in the smoke test against the built dist.
export function registerTestConnectionTool(authedRequest: AuthedRequest): void {
  registerTool("gh.test_connection", {
    description:
      "Verify GitHub auth health. Runs `{ viewer { login } }` and " +
      "returns the authenticated user's login plus the OAuth scopes " +
      "attached to the resolved PAT.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => testConnection(authedRequest),
  });
}

export async function testConnection(
  authedRequest: AuthedRequest,
): Promise<TestConnectionResult> {
  let response;
  try {
    response = await authedRequest("POST /graphql", { query: VIEWER_QUERY });
  } catch (err) {
    throw mapAuthError(err);
  }

  const payload = response.data as ViewerGraphqlPayload;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors
      .map((e) => e.message ?? "unknown")
      .join("; ");
    throw new Error(
      `mcp-github: gh.test_connection: GraphQL errors from viewer query: ${messages}`,
    );
  }

  const login = payload.data?.viewer?.login;
  if (typeof login !== "string" || login.length === 0) {
    throw new Error(
      "mcp-github: gh.test_connection: viewer.login missing in GraphQL response",
    );
  }

  return { login, scopes: parseScopes(response.headers) };
}

// `x-oauth-scopes` is a comma-separated list (e.g. "repo, read:org").
// GitHub omits the header entirely for fine-grained PATs, in which case
// we return an empty array; the consumer can still treat that as a
// successful auth probe — login was returned, after all.
function parseScopes(headers: Record<string, unknown>): string[] {
  const raw = headers["x-oauth-scopes"];
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Surface the auth-failure shapes that callers actually need to
// distinguish (token wrong vs. token correct but missing scope) as a
// structured Error rather than letting a raw RequestError stack-trace
// bubble up through the MCP transport.
function mapAuthError(err: unknown): Error {
  if (err instanceof RequestError) {
    if (err.status === 401) {
      return new Error(
        "mcp-github: gh.test_connection: 401 Unauthorized — token is missing, expired, or revoked",
      );
    }
    if (err.status === 403) {
      return new Error(
        "mcp-github: gh.test_connection: 403 Forbidden — token rejected (insufficient scopes or rate-limited)",
      );
    }
    return new Error(
      `mcp-github: gh.test_connection: HTTP ${err.status} — ${err.message}`,
    );
  }
  if (err instanceof Error) return err;
  return new Error(`mcp-github: gh.test_connection: ${String(err)}`);
}
