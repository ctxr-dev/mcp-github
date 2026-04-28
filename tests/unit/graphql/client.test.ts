// tests/unit/graphql/client.test.ts
//
// Tests the GraphQL client end-to-end with a stubbed `AuthedRequest`.
// We feed the loader the real `_health/viewer.graphql` (so the
// query-name → file-contents path is exercised against the
// canonical layout) and synthesize the network response in each
// test for the bits we want to assert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@octokit/request-error";

import { createGraphqlClient } from "../../../src/graphql/client.ts";
import {
  GraphqlError,
  RateLimitExhaustedError,
  AbuseDetectionError,
} from "../../../src/graphql/errors.ts";
import { _resetQueryCache } from "../../../src/graphql/queries.ts";
import type { AuthedRequest } from "../../../src/auth/octokit.ts";

interface StubResponse {
  data: unknown;
  headers: Record<string, unknown>;
  status?: number;
}

function stubAuthedRequest(
  fn: (route: string, opts: Record<string, unknown>) => Promise<StubResponse>,
): AuthedRequest {
  return fn as unknown as AuthedRequest;
}

function stubReject(err: unknown): AuthedRequest {
  return stubAuthedRequest(() => Promise.reject(err));
}

function rlHeaders(remaining: number): Record<string, string> {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": "1800000000",
    "x-ratelimit-used": String(5000 - remaining),
  };
}

function buildAbuseError(headers: Record<string, unknown>): RequestError {
  const err = new RequestError("Forbidden", 403, {
    request: {
      method: "POST",
      url: "https://api.github.com/graphql",
      headers: {},
    },
  });
  // RequestError exposes `response` as readonly; assigning works at
  // runtime because the getter is plain. We synthesize a minimal
  // OctokitResponse-shaped object — only the headers matter to the
  // mapper under test.
  (err as unknown as { response: { headers: Record<string, unknown> } }).response = {
    headers,
  };
  return err;
}

test("graphql: loads query by name, posts, returns unwrapped data", async () => {
  _resetQueryCache();
  let capturedQuery: string | undefined;
  let capturedVars: unknown;
  const stub = stubAuthedRequest(async (route, opts) => {
    assert.equal(route, "POST /graphql");
    capturedQuery = (opts as { query?: string }).query;
    capturedVars = (opts as { variables?: unknown }).variables;
    return {
      data: { data: { viewer: { login: "alice" } } },
      headers: rlHeaders(4999),
    };
  });
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  const result = await graphql<{ viewer: { login: string } }>(
    "_health/viewer",
    { x: 1 },
  );
  assert.deepEqual(result, { viewer: { login: "alice" } });
  assert.match(capturedQuery ?? "", /viewer/);
  assert.deepEqual(capturedVars, { x: 1 });
});

test("graphql: maps response.errors[] onto GraphqlError, preserving the array", async () => {
  _resetQueryCache();
  const stub = stubAuthedRequest(async () => ({
    data: {
      data: null,
      errors: [
        { type: "NOT_FOUND", message: "no such repo", path: ["repository"] },
      ],
    },
    headers: rlHeaders(4999),
  }));
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  await assert.rejects(
    graphql("_health/viewer"),
    (err: unknown) => {
      assert.ok(err instanceof GraphqlError);
      assert.equal((err as GraphqlError).errors[0]?.type, "NOT_FOUND");
      return true;
    },
  );
});

test("graphql: emits warning when rate-limit remaining drops below threshold", async () => {
  _resetQueryCache();
  const stub = stubAuthedRequest(async () => ({
    data: { data: { viewer: { login: "alice" } } },
    headers: rlHeaders(5),
  }));
  const warnings: string[] = [];
  const graphql = createGraphqlClient(stub, {
    warn: (m) => warnings.push(m),
  });
  await graphql("_health/viewer");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /rate limit low/);
});

test("graphql: throws RateLimitExhaustedError when remaining hits zero", async () => {
  _resetQueryCache();
  const stub = stubAuthedRequest(async () => ({
    data: { data: { viewer: { login: "alice" } } },
    headers: rlHeaders(0),
  }));
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  await assert.rejects(graphql("_health/viewer"), RateLimitExhaustedError);
});

test("graphql: maps 403 + x-secondary-rate-limit onto AbuseDetectionError with retry-after", async () => {
  _resetQueryCache();
  const err = buildAbuseError({
    "x-secondary-rate-limit": "true",
    "retry-after": "30",
  });
  const stub = stubReject(err);
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  await assert.rejects(graphql("_health/viewer"), (caught: unknown) => {
    assert.ok(caught instanceof AbuseDetectionError);
    assert.equal((caught as AbuseDetectionError).retryAfterSeconds, 30);
    return true;
  });
});

test("graphql: AbuseDetectionError defaults to 60s when retry-after header is missing", async () => {
  _resetQueryCache();
  const err = buildAbuseError({ "x-secondary-rate-limit": "true" });
  const stub = stubReject(err);
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  await assert.rejects(graphql("_health/viewer"), (caught: unknown) => {
    assert.equal((caught as AbuseDetectionError).retryAfterSeconds, 60);
    return true;
  });
});

test("graphql: 403 without x-secondary-rate-limit falls through as the underlying RequestError", async () => {
  _resetQueryCache();
  // Ordinary auth-failure 403s must not be mistaken for abuse-detection,
  // otherwise the consumer gets a "retry in 60s" message for what is
  // actually a permanent permissions problem.
  const err = buildAbuseError({});
  const stub = stubReject(err);
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  await assert.rejects(graphql("_health/viewer"), (caught: unknown) => {
    assert.ok(caught instanceof RequestError);
    return true;
  });
});

test("graphql: throws when query name doesn't resolve to any file", async () => {
  _resetQueryCache();
  const stub = stubAuthedRequest(async () => {
    throw new Error("network should not be hit when query is missing");
  });
  const graphql = createGraphqlClient(stub, { warn: () => {} });
  await assert.rejects(
    graphql("does_not_exist/anywhere"),
    /unknown GraphQL query/,
  );
});
