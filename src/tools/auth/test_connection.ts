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

const VIEWER_QUERY = "query { viewer { login } }";

export interface TestConnectionResult {
  login: string;
  scopes: string[];
}

interface ViewerGraphqlPayload {
  data?: { viewer?: { login?: string } };
  errors?: Array<{ message?: string }>;
}

// Shape of a tool-registry entry. Inlined here (rather than imported
// from server.ts) so this module has no compile-time dependency on
// the server module: server.ts → test_connection.ts is the only
// import direction, which keeps the registry-loading sequence
// linear at module-init time.
interface ToolEntryShape {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
type RegisterToolFn = (name: string, entry: ToolEntryShape) => void;

// Caller passes in `register` (typically server.ts's `registerTool`)
// plus the resolved authed client. Decoupling the registration
// callable from a static import breaks the would-be cycle where
// server.ts imports this module while this module imports
// `registerTool` back from server.ts. The same shape covers any
// future "the tool registers itself" pattern without re-introducing
// the cycle.
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
