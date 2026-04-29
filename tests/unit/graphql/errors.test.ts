// tests/unit/graphql/errors.test.ts
//
// Pin the structured error classes so consumers can rely on
// `instanceof` + the documented properties (errors[], resetAt,
// retryAfterSeconds). These tests are intentionally lightweight —
// they exist mainly so a future refactor of error shapes is forced
// to update the contract here, not silently change consumer-visible
// behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GraphqlError,
  RateLimitExhaustedError,
  AbuseDetectionError,
} from "../../../src/graphql/errors.ts";

test("GraphqlError: preserves the response errors[] array verbatim", () => {
  const errors = [
    { type: "NOT_FOUND", message: "Could not resolve to a User", path: ["viewer"] },
    { type: "FORBIDDEN", message: "must have admin access" },
  ];
  const e = new GraphqlError(errors);
  assert.equal(e.name, "GraphqlError");
  assert.equal(e.errors.length, 2);
  assert.equal(e.errors[0]?.type, "NOT_FOUND");
  assert.match(e.message, /NOT_FOUND/);
  assert.match(e.message, /FORBIDDEN/);
});

test("GraphqlError: handles errors with no type/message gracefully", () => {
  const e = new GraphqlError([{}]);
  assert.match(e.message, /ERROR: unknown/);
});

test("RateLimitExhaustedError: surfaces resetAt + limit + ISO date in message", () => {
  // Pick a deterministic instant (not Date.now) so the message check
  // doesn't drift with the test clock.
  const resetAt = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
  const e = new RateLimitExhaustedError(resetAt, 5000);
  assert.equal(e.name, "RateLimitExhaustedError");
  assert.equal(e.resetAt, resetAt);
  assert.equal(e.limit, 5000);
  assert.match(e.message, /2026-01-15T12:00:00\.000Z/);
});

test("AbuseDetectionError: stores retry-after seconds", () => {
  const e = new AbuseDetectionError(120);
  assert.equal(e.name, "AbuseDetectionError");
  assert.equal(e.retryAfterSeconds, 120);
  assert.match(e.message, /retry after 120s/);
});
