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

// `headers` is typed loosely (Record<string, unknown>) because both
// `@octokit/request` (which always returns `Record<string, string>`)
// and Node's stock `fetch` (which returns `Headers`) need to flow
// through here. Callers normalise to a plain object before calling.
export function parseRateLimit(
  headers: Record<string, unknown>,
): ParsedRateLimit | undefined {
  const limit = readNumber(headers["x-ratelimit-limit"]);
  const remaining = readNumber(headers["x-ratelimit-remaining"]);
  const resetAt = readNumber(headers["x-ratelimit-reset"]);
  const used = readNumber(headers["x-ratelimit-used"]);
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
  headers: Record<string, unknown>,
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
