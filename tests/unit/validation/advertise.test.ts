// tests/unit/validation/advertise.test.ts
//
// Pins toPublicInputSchema: it must remove ONLY the top-level
// oneOf/allOf/anyOf keywords the Anthropic tool-use API rejects, keep
// every other key (including nested unions), and never mutate the
// input the handlers still validate against with ajv.

import { test } from "node:test";
import assert from "node:assert/strict";

import { toPublicInputSchema } from "../../../src/validation/advertise.ts";

test("toPublicInputSchema: strips a top-level oneOf, keeps the rest", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
    oneOf: [{ required: ["a"] }, { required: ["b"] }],
    additionalProperties: false,
  };
  assert.deepEqual(toPublicInputSchema(schema), {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  });
});

test("toPublicInputSchema: strips top-level allOf and anyOf", () => {
  const out = toPublicInputSchema({
    type: "object",
    allOf: [{ oneOf: [{ required: ["x"] }] }],
    anyOf: [{ required: ["y"] }],
  });
  assert.equal("allOf" in out, false);
  assert.equal("anyOf" in out, false);
  assert.equal(out["type"], "object");
});

test("toPublicInputSchema: preserves a nested oneOf under a property", () => {
  const out = toPublicInputSchema({
    type: "object",
    properties: {
      value: {
        type: "object",
        oneOf: [{ required: ["text"] }, { required: ["number"] }],
      },
    },
    allOf: [{ oneOf: [{ required: ["a"] }] }],
  });
  assert.equal("allOf" in out, false);
  const props = out["properties"] as Record<string, unknown>;
  const value = props["value"] as Record<string, unknown>;
  assert.ok(Array.isArray(value["oneOf"]));
  assert.equal((value["oneOf"] as unknown[]).length, 2);
});

test("toPublicInputSchema: does not mutate the input (ajv keeps the union)", () => {
  const schema = { type: "object", oneOf: [{ required: ["a"] }] };
  toPublicInputSchema(schema);
  assert.ok("oneOf" in schema, "input must keep oneOf for runtime validation");
});

test("toPublicInputSchema: returns the same object when nothing to strip", () => {
  const schema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  assert.equal(toPublicInputSchema(schema), schema);
});
