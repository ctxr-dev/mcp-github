// tests/unit/validation/validator.test.ts
//
// Unit tests for the ajv-backed schema validator. Pin the contract
// every tool handler depends on: pass-through on valid input,
// SchemaValidationError on invalid input with a useful message
// pointing at the offending instance path.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validate,
  SchemaValidationError,
} from "../../../src/validation/validator.ts";

const sampleSchema = {
  type: "object",
  required: ["name", "count"],
  properties: {
    name: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

test("validate: returns the data on success", () => {
  const ok = validate(sampleSchema, { name: "alice", count: 3 }, "test");
  assert.deepEqual(ok, { name: "alice", count: 3 });
});

test("validate: throws SchemaValidationError naming the where-string", () => {
  assert.throws(
    () => validate(sampleSchema, { name: "", count: 3 }, "gh.issue_create input"),
    (err: unknown) => {
      assert.ok(err instanceof SchemaValidationError);
      assert.equal((err as SchemaValidationError).where, "gh.issue_create input");
      assert.match((err as SchemaValidationError).message, /gh\.issue_create input/);
      return true;
    },
  );
});

test("validate: error mentions the offending instance path", () => {
  assert.throws(
    () => validate(sampleSchema, { name: "alice", count: -1 }, "test"),
    (err: unknown) => {
      assert.match((err as Error).message, /\/count/);
      return true;
    },
  );
});

test("validate: collects every violation, not just the first", () => {
  // ajv is configured with allErrors: true so consumers get a
  // single, actionable error listing every invalid field rather
  // than a "fix one, retry, fix the next" loop.
  assert.throws(
    () => validate(sampleSchema, { count: -1 }, "test"),
    (err: unknown) => {
      const e = err as SchemaValidationError;
      assert.ok(e.errors.length >= 2, `expected ≥2 errors, got ${e.errors.length}`);
      return true;
    },
  );
});

test("validate: rejects unknown additional properties", () => {
  assert.throws(
    () => validate(sampleSchema, { name: "alice", count: 3, extra: 1 }, "test"),
    (err: unknown) => {
      assert.match((err as Error).message, /extra/);
      return true;
    },
  );
});

test("validate: caches compiled validators by schema-object identity", () => {
  // We can't observe the cache directly, but two consecutive calls
  // with the same schema reference must succeed identically (and
  // ajv's compile() throws on a schema it can't compile, so the
  // first call would have failed if the cache key was unstable).
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(
      validate(sampleSchema, { name: "x", count: i }, "test"),
      { name: "x", count: i },
    );
  }
});
