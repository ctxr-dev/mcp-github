// tests/unit/auth/pat.test.ts
//
// Unit tests for `resolvePat()`. Exercise each fallback env var in
// isolation, verify precedence when multiple are set, and confirm the
// missing-everything path surfaces `MissingPatError` (not a generic
// Error) so downstream callers can distinguish auth misconfig from a
// runtime crash.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePat,
  MissingPatError,
  PAT_ENV_VARS,
} from "../../../src/auth/pat.ts";

// Build a synthetic env that matches the NodeJS.ProcessEnv shape the
// resolver expects. Tests pass these in directly rather than mutating
// `process.env`, which would race other tests in the same `node --test`
// run.
function syntheticEnv(
  overrides: Partial<Record<string, string>>,
): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

test("resolvePat: GITHUB_TOKEN is the first-choice source", () => {
  const env = syntheticEnv({ GITHUB_TOKEN: "ghp_one" });
  assert.equal(resolvePat(env), "ghp_one");
});

test("resolvePat: falls back to GH_TOKEN when GITHUB_TOKEN is unset", () => {
  const env = syntheticEnv({ GH_TOKEN: "ghp_two" });
  assert.equal(resolvePat(env), "ghp_two");
});

test("resolvePat: falls back to GITHUB_PERSONAL_ACCESS_TOKEN as last resort", () => {
  const env = syntheticEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_three" });
  assert.equal(resolvePat(env), "ghp_three");
});

test("resolvePat: precedence — GITHUB_TOKEN beats GH_TOKEN beats GITHUB_PERSONAL_ACCESS_TOKEN", () => {
  const env = syntheticEnv({
    GITHUB_TOKEN: "first",
    GH_TOKEN: "second",
    GITHUB_PERSONAL_ACCESS_TOKEN: "third",
  });
  assert.equal(resolvePat(env), "first");
});

test("resolvePat: skips empty-string values (treats them as unset)", () => {
  // CI runners frequently set GITHUB_TOKEN="" when no token is configured,
  // which would silently mask the GH_TOKEN fallback if we only checked
  // for `undefined`.
  const env = syntheticEnv({
    GITHUB_TOKEN: "",
    GH_TOKEN: "ghp_real",
  });
  assert.equal(resolvePat(env), "ghp_real");
});

test("resolvePat: throws MissingPatError listing every checked env var when none set", () => {
  const env = syntheticEnv({});
  assert.throws(
    () => resolvePat(env),
    (err: unknown) => {
      assert.ok(err instanceof MissingPatError);
      // Spot-check that the message names every fallback so a developer
      // hitting this in the wild knows exactly which envs to set.
      for (const v of PAT_ENV_VARS) {
        assert.match((err as Error).message, new RegExp(v));
      }
      return true;
    },
  );
});

test("PAT_ENV_VARS: declares the canonical fallback chain in priority order", () => {
  // Pin the contract so any future re-ordering shows up as a test
  // change rather than a silent behavioural drift.
  assert.deepEqual(PAT_ENV_VARS, [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
  ]);
});
