// src/graphql/client.ts
//
// Thin GraphQL client used by every domain tool from MCP-4 onwards.
// It is a wrapper around `@octokit/request` (POST /graphql) rather
// than `@octokit/graphql` because we need the response headers
// (rate-limit + abuse-detection signals) that the higher-level
// graphql client unwraps and discards.
//
// The public surface is a single function:
//
//     const graphql = createGraphqlClient(authedRequest);
//     const data = await graphql<ResponseShape>("group/name", { vars });
//
// The query name is the file path under `src/graphql/queries/` minus
// the `.graphql` suffix (e.g. `_health/viewer` → loads
// `src/graphql/queries/_health/viewer.graphql`). It does NOT include
// a leading `queries/` segment.
//
// Errors are mapped onto three structured classes (see ./errors.ts):
//   - GraphqlError (response carries an `errors[]` array)
//   - RateLimitExhaustedError (X-RateLimit-Remaining hit zero)
//   - AbuseDetectionError (HTTP 403 + x-secondary-rate-limit)
//
// Anything else (network failures, 5xx, auth failures) falls through
// as the underlying RequestError, so callers can still match on it.

import { RequestError } from "@octokit/request-error";
import type { AuthedRequest } from "../auth/octokit.js";
import {
  GraphqlError,
  AbuseDetectionError,
  type GraphqlErrorEntry,
} from "./errors.js";
import { enforceRateLimit } from "./rate_limit.js";
import { loadQuery } from "./queries.js";

interface GraphqlResponseBody<T> {
  data?: T;
  errors?: GraphqlErrorEntry[];
}

export type GraphqlClient = <T = unknown>(
  queryName: string,
  vars?: Record<string, unknown>,
) => Promise<T>;

export interface CreateGraphqlClientOptions {
  // Custom warn sink, primarily for tests. Defaults to writing to
  // stderr. Provided as an option (rather than a top-level monkey
  // patch) so server boot can wire in a structured logger later
  // without rewriting client internals.
  warn?: (msg: string) => void;
}

export function createGraphqlClient(
  authedRequest: AuthedRequest,
  options: CreateGraphqlClientOptions = {},
): GraphqlClient {
  const warn = options.warn;
  return async function graphql<T = unknown>(
    queryName: string,
    vars: Record<string, unknown> = {},
  ): Promise<T> {
    const query = await loadQuery(queryName);

    let response;
    try {
      response = await authedRequest("POST /graphql", {
        query,
        variables: vars,
      });
    } catch (err) {
      throw mapRequestError(err);
    }

    // Run rate-limit policy against the response headers. We do this
    // *before* checking the GraphQL `errors[]` payload so a
    // rate-limit response (which can sometimes also carry errors)
    // surfaces as the more actionable RateLimitExhaustedError.
    enforceRateLimit(
      response.headers as Record<string, unknown>,
      warn,
    );

    const body = response.data as GraphqlResponseBody<T>;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new GraphqlError(body.errors);
    }
    if (body.data === undefined) {
      throw new Error(
        `mcp-github: GraphQL query '${queryName}' returned no data field`,
      );
    }
    return body.data;
  };
}

function mapRequestError(err: unknown): Error {
  if (err instanceof RequestError) {
    // GitHub's secondary rate limit ("abuse detection") arrives as a
    // 403 with `x-secondary-rate-limit: true`. The retry-after value
    // can land in either `retry-after` (seconds) or be missing — when
    // missing we use 60s as a conservative floor that matches GitHub's
    // own backoff guidance.
    if (err.status === 403 && isSecondaryRateLimit(err)) {
      const retryAfter = readRetryAfter(err) ?? 60;
      return new AbuseDetectionError(retryAfter);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isSecondaryRateLimit(err: RequestError): boolean {
  const headers = err.response?.headers as Record<string, unknown> | undefined;
  if (!headers) return false;
  const v = headers["x-secondary-rate-limit"];
  return v === "true" || v === true;
}

function readRetryAfter(err: RequestError): number | undefined {
  const headers = err.response?.headers as Record<string, unknown> | undefined;
  const raw = headers?.["retry-after"];
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof raw === "number") return raw;
  return undefined;
}
