// tests/unit/tools/auth/test_connection.test.ts
//
// Unit tests for the `gh.test_connection` handler. We exercise the
// handler in isolation (not via the registerTool / MCP transport path,
// which the smoke test covers end-to-end) by feeding it a synthetic
// `AuthedRequest` that returns whatever shape we want for the case
// under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@octokit/request-error";

import { testConnection } from "../../../../src/tools/auth/test_connection.ts";
import type { AuthedRequest } from "../../../../src/auth/octokit.ts";

interface StubResponse {
  data: unknown;
  headers: Record<string, string>;
  status?: number;
}

// Octokit's `request` type is a callable with overloads + `defaults` +
// `endpoint` properties. For unit tests we only invoke the call shape,
// so we cast a minimal stub to the full type. The cast is annotated
// so a future change that makes the test rely on the heavier surface
// (e.g. `endpoint`) breaks here loudly.
function stubAuthedRequest(
  fn: (route: string, opts: Record<string, unknown>) => Promise<StubResponse>,
): AuthedRequest {
  return fn as unknown as AuthedRequest;
}

function stubReject(err: unknown): AuthedRequest {
  return stubAuthedRequest(() => Promise.reject(err));
}

function buildRequestError(status: number): RequestError {
  // The constructor takes a message + status + opts containing the
  // originating RequestOptions. We pass a minimal route since this
  // error never actually flows back through Octokit.
  return new RequestError(`HTTP ${status}`, status, {
    request: {
      method: "POST",
      url: "https://api.github.com/graphql",
      headers: {},
    },
  });
}

test("testConnection: returns login + parsed scopes on a healthy response", async () => {
  const stub = stubAuthedRequest(async (route, opts) => {
    assert.equal(route, "POST /graphql");
    assert.equal(
      (opts as { query?: string }).query,
      "query { viewer { login } }",
    );
    return {
      data: { data: { viewer: { login: "alice" } } },
      headers: { "x-oauth-scopes": "repo, read:org, workflow" },
    };
  });
  const result = await testConnection(stub);
  assert.deepEqual(result, {
    login: "alice",
    scopes: ["repo", "read:org", "workflow"],
  });
});

test("testConnection: empty scopes when x-oauth-scopes header is missing (fine-grained PAT)", async () => {
  // Fine-grained PATs and some GitHub App installations don't emit
  // `x-oauth-scopes` at all. That's still a valid auth probe — we
  // got `viewer.login` back — so we return scopes: [].
  const stub = stubAuthedRequest(async () => ({
    data: { data: { viewer: { login: "bob" } } },
    headers: {},
  }));
  const result = await testConnection(stub);
  assert.deepEqual(result, { login: "bob", scopes: [] });
});

test("testConnection: tolerates whitespace-only entries in the scopes header", async () => {
  const stub = stubAuthedRequest(async () => ({
    data: { data: { viewer: { login: "carol" } } },
    headers: { "x-oauth-scopes": "repo,  ,read:user" },
  }));
  const result = await testConnection(stub);
  assert.deepEqual(result.scopes, ["repo", "read:user"]);
});

test("testConnection: throws structured 401 error when token is unauthorized", async () => {
  const stub = stubReject(buildRequestError(401));
  await assert.rejects(testConnection(stub), /401 Unauthorized/);
});

test("testConnection: throws structured 403 error when token is forbidden", async () => {
  const stub = stubReject(buildRequestError(403));
  await assert.rejects(testConnection(stub), /403 Forbidden/);
});

test("testConnection: surfaces other HTTP statuses with the status code preserved", async () => {
  const stub = stubReject(buildRequestError(502));
  await assert.rejects(testConnection(stub), /HTTP 502/);
});

test("testConnection: throws when GraphQL response carries errors", async () => {
  const stub = stubAuthedRequest(async () => ({
    data: {
      data: null,
      errors: [{ message: "Bad credentials" }],
    },
    headers: {},
  }));
  await assert.rejects(testConnection(stub), /Bad credentials/);
});

test("testConnection: throws when viewer.login is missing", async () => {
  // Defensive: GitHub has been known to return `data: { viewer: null }`
  // for tokens with no user context (e.g. some installation tokens).
  // We treat that as a misconfiguration rather than letting the
  // empty-string login propagate to consumers.
  const stub = stubAuthedRequest(async () => ({
    data: { data: { viewer: null } },
    headers: {},
  }));
  await assert.rejects(testConnection(stub), /viewer\.login missing/);
});

test("testConnection: passes through non-RequestError errors unchanged shape", async () => {
  const original = new Error("network exploded");
  const stub = stubReject(original);
  await assert.rejects(testConnection(stub), /network exploded/);
});
