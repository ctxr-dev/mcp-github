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
// Type-only import: erased at compile time, so it does NOT create
// a runtime dependency on the registry module. We reuse the
// canonical ToolEntry shape from `src/registry.ts` so tool typings
// stay aligned with the registry contract; an inlined duplicate
// would drift as soon as the registry's shape evolved.
import type { ToolEntry } from "../../registry.js";

const VIEWER_QUERY = "query { viewer { login } }";

export interface TestConnectionResult {
  login: string;
  scopes: string[];
}

interface ViewerGraphqlPayload {
  data?: { viewer?: { login?: string } };
  errors?: Array<{ message?: string }>;
}

// Caller passes in the registration function (typically the
// registry's `registerTool`) plus the resolved authed client.
// Decoupling the registration callable from a static import keeps
// the dependency arrow strictly server.ts → tools/**: tool modules
// never import from server.ts at runtime, even transitively, which
// avoids any TDZ trap if a future tool registers at module-import
// time.
type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerTestConnectionTool(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  register("gh.test_connection", {
    description:
      "Verify GitHub auth health. Runs `{ viewer { login } }` and " +
      "returns the authenticated user's login plus the OAuth scopes " +
      "advertised in the `x-oauth-scopes` response header. " +
      "Note: `scopes` is `[]` for fine-grained PATs and most GitHub " +
      "App tokens, where GitHub does not emit that header — an empty " +
      "list means \"unknown\", not \"no scopes\".",
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
// GitHub omits the header entirely for fine-grained PATs and most
// GitHub App tokens, in which case we return an empty array. Auth is
// still healthy in that case (login came back), but consumers must
// not interpret `[]` as "the token has no permissions" — it means
// "scope information is unavailable", not "scopes empty". The tool
// description spells this out for callers.
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
//
// We append the upstream RequestError message via `withDetail()`
// because GitHub's 401/403 responses often carry useful context like
// "SSO required", "API rate limit exceeded", or the specific scope
// the token is missing. Dropping that on the floor would leave the
// caller staring at a generic "401 Unauthorized" with no diagnostic
// trail.
function mapAuthError(err: unknown): Error {
  if (err instanceof RequestError) {
    const detail =
      typeof err.message === "string" ? err.message.trim() : "";
    const withDetail = (message: string): Error =>
      new Error(detail.length > 0 ? `${message} — upstream: ${detail}` : message);
    if (err.status === 401) {
      return withDetail(
        "mcp-github: gh.test_connection: 401 Unauthorized — token is missing, expired, or revoked",
      );
    }
    if (err.status === 403) {
      return withDetail(
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
