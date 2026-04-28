// tests/unit/graphql/rate_limit.test.ts
//
// Tests the rate-limit policy: header parsing, the low-remaining
// warning threshold, and the hard-zero throw. These run with no
// network access — the input to `enforceRateLimit` is a plain
// headers object that we construct directly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRateLimit,
  enforceRateLimit,
  LOW_REMAINING_THRESHOLD,
} from "../../../src/graphql/rate_limit.ts";
import { RateLimitExhaustedError } from "../../../src/graphql/errors.ts";

function rlHeaders(overrides: Partial<Record<string, string>> = {}) {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-reset": "1800000000",
    "x-ratelimit-used": "1",
    ...overrides,
  } as Record<string, unknown>;
}

test("parseRateLimit: parses the canonical four headers", () => {
  const rl = parseRateLimit(rlHeaders());
  assert.deepEqual(rl, {
    limit: 5000,
    remaining: 4999,
    resetAt: 1800000000,
    used: 1,
  });
});

test("parseRateLimit: returns undefined when any header is missing", () => {
  // Half-parsed records would mislead the threshold checks; treat
  // partial sets as absent.
  const headers = rlHeaders();
  delete (headers as Record<string, unknown>)["x-ratelimit-reset"];
  assert.equal(parseRateLimit(headers), undefined);
});

test("parseRateLimit: tolerates numeric values (not just strings)", () => {
  // node:fetch sometimes hands us numeric headers; @octokit/request
  // always strings. We support both for safety.
  const headers = {
    "x-ratelimit-limit": 5000,
    "x-ratelimit-remaining": 4999,
    "x-ratelimit-reset": 1800000000,
    "x-ratelimit-used": 1,
  };
  const rl = parseRateLimit(headers);
  assert.equal(rl?.limit, 5000);
});

test("enforceRateLimit: healthy response is silent", () => {
  const warnings: string[] = [];
  const rl = enforceRateLimit(rlHeaders(), (m) => warnings.push(m));
  assert.equal(warnings.length, 0);
  assert.equal(rl?.remaining, 4999);
});

test(`enforceRateLimit: warns when remaining drops below ${LOW_REMAINING_THRESHOLD}`, () => {
  const warnings: string[] = [];
  enforceRateLimit(
    rlHeaders({ "x-ratelimit-remaining": String(LOW_REMAINING_THRESHOLD - 1) }),
    (m) => warnings.push(m),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /rate limit low/);
  assert.match(warnings[0] ?? "", new RegExp(String(LOW_REMAINING_THRESHOLD - 1)));
});

test("enforceRateLimit: does not warn at exactly the threshold", () => {
  // The threshold is "< LOW_REMAINING_THRESHOLD", not "<=", so a value
  // sitting exactly on the line is still considered healthy. Pin this
  // boundary explicitly so a future refactor that flips the comparator
  // surfaces here.
  const warnings: string[] = [];
  enforceRateLimit(
    rlHeaders({ "x-ratelimit-remaining": String(LOW_REMAINING_THRESHOLD) }),
    (m) => warnings.push(m),
  );
  assert.equal(warnings.length, 0);
});

test("enforceRateLimit: throws RateLimitExhaustedError when remaining is 0", () => {
  assert.throws(
    () => enforceRateLimit(rlHeaders({ "x-ratelimit-remaining": "0" }), () => {}),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitExhaustedError);
      assert.equal((err as RateLimitExhaustedError).resetAt, 1800000000);
      assert.equal((err as RateLimitExhaustedError).limit, 5000);
      return true;
    },
  );
});

test("enforceRateLimit: returns undefined and is silent when headers are absent", () => {
  // Some test fixtures (and a few legitimate GitHub responses, like
  // `200 OK` from a cached static asset) don't carry rate-limit
  // headers at all. Treat that as "no signal" rather than crashing.
  const warnings: string[] = [];
  const rl = enforceRateLimit({}, (m) => warnings.push(m));
  assert.equal(rl, undefined);
  assert.equal(warnings.length, 0);
});
