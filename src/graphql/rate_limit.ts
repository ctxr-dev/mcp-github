// src/graphql/rate_limit.ts
//
// GitHub's primary rate-limit signal lives in `X-RateLimit-*` response
// headers. We surface three states:
//
//   - healthy: no action needed
//   - low: remaining < threshold; emit a structured warning so
//     long-running runners notice the cliff before they hit it
//   - exhausted: remaining == 0; throw RateLimitExhaustedError so the
//     caller can back off until `resetAt`
//
// Secondary rate limits (the "abuse detection" path) are NOT in these
// headers — those arrive as HTTP 403 with `x-secondary-rate-limit: true`
// and are handled in client.ts.

import { RateLimitExhaustedError } from "./errors.js";

// Accept both shapes that callers actually have: a plain object
// (`@octokit/request` always returns `Record<string, string>` for
// `response.headers`) and a `Headers` instance (which Node's stock
// `fetch` returns). The parser detects the latter via
// `headers instanceof Headers` and routes through `Headers.get(...)`,
// while the former is read by direct property lookup. Without this
// dual support a `Headers` argument would silently report "no
// rate-limit info" because the property-style read returns
// `undefined`.
type HeaderBag = Record<string, unknown> | Headers;

// 10 is GitHub's own internal "you're getting close" line in their
// public guidance for the GraphQL API. Below that, parallel runners
// can easily blow past zero before we observe the next response.
export const LOW_REMAINING_THRESHOLD = 10;

export interface ParsedRateLimit {
  limit: number;
  remaining: number;
  resetAt: number; // unix epoch seconds
  used: number;
}

export function parseRateLimit(
  headers: HeaderBag,
): ParsedRateLimit | undefined {
  const get = headerReader(headers);
  const limit = readNumber(get("x-ratelimit-limit"));
  const remaining = readNumber(get("x-ratelimit-remaining"));
  const resetAt = readNumber(get("x-ratelimit-reset"));
  const used = readNumber(get("x-ratelimit-used"));
  // GitHub returns these as a unit; if any are missing we treat the
  // header set as absent. Don't half-parse — a partial record would
  // mislead the threshold checks below.
  if (
    limit === undefined ||
    remaining === undefined ||
    resetAt === undefined ||
    used === undefined
  ) {
    return undefined;
  }
  return { limit, remaining, resetAt, used };
}

// Return the rate-limit record for callers who want to inspect it,
// after applying the warn/throw policy. Throws RateLimitExhaustedError
// if remaining == 0; emits a stderr warning if remaining < threshold.
// `warn` is parameterised so tests can capture invocations without
// taking over `console.warn` globally.
export function enforceRateLimit(
  headers: HeaderBag,
  warn: (msg: string) => void = (msg) => process.stderr.write(`${msg}\n`),
): ParsedRateLimit | undefined {
  const rl = parseRateLimit(headers);
  if (!rl) return undefined;
  if (rl.remaining === 0) {
    throw new RateLimitExhaustedError(rl.resetAt, rl.limit);
  }
  if (rl.remaining < LOW_REMAINING_THRESHOLD) {
    warn(
      `mcp-github: GraphQL rate limit low: ${rl.remaining}/${rl.limit} ` +
        `remaining (resets at ${new Date(rl.resetAt * 1000).toISOString()})`,
    );
  }
  return rl;
}

function readNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Returns a unified accessor that handles both header shapes (plain
// object lookup vs `Headers.get()`). The Headers branch deliberately
// uses `instanceof` rather than duck-typing on `.get` because plain
// objects can legitimately have a `get` property of a different shape
// (e.g. a `Map` masquerading as headers).
function headerReader(headers: HeaderBag): (name: string) => unknown {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return (name) => headers.get(name) ?? undefined;
  }
  const obj = headers as Record<string, unknown>;
  return (name) => obj[name];
}
