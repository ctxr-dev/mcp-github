// src/graphql/errors.ts
//
// Structured error classes for the GraphQL client. Each one preserves
// the GitHub-side signal a consumer would actually use to decide
// behaviour:
//
//   - GraphqlError carries the response's `errors[]` shape so callers
//     can branch on `type` ("NOT_FOUND", "FORBIDDEN", etc.).
//   - RateLimitExhaustedError carries the reset epoch so a polling
//     consumer knows when to retry.
//   - AbuseDetectionError carries the `retry-after` seconds (or 60 as
//     a safe default) for the same reason.
//
// All three extend Error so the MCP transport's default surface
// (stack trace + message) still works. Subclassing also lets unit
// tests use `instanceof` rather than parsing message strings.

export interface GraphqlErrorEntry {
  type?: string;
  message?: string;
  path?: ReadonlyArray<string | number>;
}

export class GraphqlError extends Error {
  override readonly name = "GraphqlError";
  readonly errors: readonly GraphqlErrorEntry[];
  constructor(errors: readonly GraphqlErrorEntry[]) {
    const summary = errors
      .map((e) => `${e.type ?? "ERROR"}: ${e.message ?? "unknown"}`)
      .join("; ");
    super(`mcp-github: GraphQL response errors: ${summary}`);
    this.errors = errors;
  }
}

export class RateLimitExhaustedError extends Error {
  override readonly name = "RateLimitExhaustedError";
  readonly resetAt: number; // unix epoch seconds, from X-RateLimit-Reset
  readonly limit: number;
  constructor(resetAt: number, limit: number) {
    super(
      `mcp-github: GraphQL rate limit exhausted (limit=${limit}, ` +
        `resetAt=${new Date(resetAt * 1000).toISOString()})`,
    );
    this.resetAt = resetAt;
    this.limit = limit;
  }
}

export class AbuseDetectionError extends Error {
  override readonly name = "AbuseDetectionError";
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(
      `mcp-github: GraphQL secondary rate limit hit (retry after ${retryAfterSeconds}s)`,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
