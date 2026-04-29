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
  _getCompileCount,
  _resetCompileCount,
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
  // Pin the actual caching contract via the _getCompileCount() test
  // hook. Five validate() calls against the same schema reference
  // must trigger exactly one ajv.compile call; a regression that
  // breaks the WeakMap key (e.g. cloning the schema before lookup)
  // would surface here as 5 compiles instead of 1.
  // Use a fresh schema object so the count is unpolluted by any
  // earlier validate() in this test file.
  const freshSchema = {
    type: "object",
    required: ["x"],
    properties: { x: { type: "integer" } },
    additionalProperties: false,
  };
  _resetCompileCount();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(validate(freshSchema, { x: i }, "test"), { x: i });
  }
  assert.equal(
    _getCompileCount(),
    1,
    "ajv.compile must be called exactly once across 5 validate() calls with the same schema",
  );
});

test("validate: a different schema reference triggers a fresh compile", () => {
  // Belt-and-brace: confirm the WeakMap key truly is the schema
  // object, not e.g. a JSON-stringified copy that would dedupe two
  // structurally-identical schemas. Two distinct objects must
  // compile twice even when their contents are equal.
  const a = { type: "object", properties: {} };
  const b = { type: "object", properties: {} };
  _resetCompileCount();
  validate(a, {}, "test");
  validate(b, {}, "test");
  assert.equal(_getCompileCount(), 2);
});
