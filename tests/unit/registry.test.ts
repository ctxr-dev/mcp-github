// tests/unit/registry.test.ts
//
// Unit tests for `src/registry.ts`. The registry sits behind the
// public `dist/server.js` entry — consumers can't reach
// `registerTool` / `getRegisteredToolNames` / `normaliseArgs` / etc.
// because they aren't re-exported. Tests reach in via a direct
// relative source-path import to `src/registry.ts`, which bypasses
// the package's `exports` map (that map only routes consumers
// through `dist/server.js`) and lets us pin the registry behaviour
// without committing to it as a public surface.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerTool,
  getRegisteredToolNames,
  listToolDescriptors,
  getToolEntry,
  normaliseArgs,
  _resetRegistry,
} from "../../src/registry.ts";

beforeEach(() => {
  // The registry is module-scoped (single Map for the lifetime of
  // the test process), so each test starts from a known empty state.
  _resetRegistry();
});

const sampleEntry = {
  description: "Example",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => ({ ok: true }),
};

test("registerTool: stores the tool under its name", () => {
  registerTool("gh.example", sampleEntry);
  assert.deepEqual(getRegisteredToolNames(), ["gh.example"]);
});

test("registerTool: rejects a duplicate name", () => {
  registerTool("gh.dup", sampleEntry);
  // Re-registering the same name surfaces a typo / missed-rename
  // immediately rather than silently shadowing the prior handler,
  // which would be very hard to debug at runtime.
  assert.throws(() => registerTool("gh.dup", sampleEntry), /already registered/);
});

test("registerTool: many tools coexist and preserve insertion order", () => {
  const expected: string[] = [];
  for (let i = 0; i < 10; i++) {
    const name = `gh.tool_${i}`;
    registerTool(name, sampleEntry);
    expected.push(name);
  }
  // Map iteration order pins the ListTools response so a refactor
  // that swaps the storage to anything unordered must surface here.
  assert.deepEqual(getRegisteredToolNames(), expected);
});

test("listToolDescriptors: returns the JSON-Schema-shaped list ListTools hands back", () => {
  registerTool("gh.alpha", { ...sampleEntry, description: "alpha" });
  registerTool("gh.beta", { ...sampleEntry, description: "beta" });
  const descriptors = listToolDescriptors();
  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0]?.name, "gh.alpha");
  assert.equal(descriptors[0]?.description, "alpha");
  assert.deepEqual(descriptors[0]?.inputSchema, sampleEntry.inputSchema);
  assert.equal(descriptors[1]?.name, "gh.beta");
});

test("listToolDescriptors: strips top-level oneOf/allOf/anyOf but keeps nested unions", () => {
  // The Anthropic tool-use API rejects a top-level oneOf/allOf/anyOf,
  // so the ADVERTISED schema must not carry one even though the stored
  // entry keeps it for ajv validation at call time.
  const schema = {
    type: "object",
    properties: {
      url: { type: "string" },
      repo: { type: "string" },
      value: { type: "object", oneOf: [{ required: ["a"] }] },
    },
    oneOf: [{ required: ["url"] }, { required: ["repo"] }],
    additionalProperties: false,
  };
  registerTool("gh.union", {
    description: "u",
    inputSchema: schema,
    handler: async () => ({}),
  });
  const advertised = listToolDescriptors()[0]?.inputSchema as Record<
    string,
    unknown
  >;
  assert.equal("oneOf" in advertised, false);
  // Nested union under a property is valid and must survive.
  const props = advertised["properties"] as Record<string, unknown>;
  const value = props["value"] as Record<string, unknown>;
  assert.ok(Array.isArray(value["oneOf"]));
  // The stored entry keeps the full schema so ajv still enforces it.
  const stored = (getToolEntry("gh.union")?.inputSchema ?? {}) as Record<
    string,
    unknown
  >;
  assert.ok("oneOf" in stored);
});

test("getToolEntry: returns the registered entry, or undefined for unknown names", () => {
  registerTool("gh.known", sampleEntry);
  assert.equal(getToolEntry("gh.known"), sampleEntry);
  assert.equal(getToolEntry("gh.unknown"), undefined);
});

// normaliseArgs is the gate every CallTool request goes through. The
// stdio transport hands the SDK's `request.params.arguments` straight
// here, and that field is `unknown` at the protocol level, so the
// handler-side type contract (`Record<string, unknown>`) only holds
// because of the coercion + rejection rules below. Pin them.

test("normaliseArgs: coerces missing arguments to {}", () => {
  assert.deepEqual(normaliseArgs(undefined, "gh.x"), {});
});

test("normaliseArgs: coerces null arguments to {}", () => {
  assert.deepEqual(normaliseArgs(null, "gh.x"), {});
});

test("normaliseArgs: passes plain objects through unchanged", () => {
  const args = { repo: "x", issue: 42 };
  assert.equal(normaliseArgs(args, "gh.x"), args);
});

test("normaliseArgs: rejects arrays with a protocol error naming the tool", () => {
  assert.throws(
    () => normaliseArgs([1, 2, 3], "gh.create_issue"),
    /tool 'gh\.create_issue' expected an object .*got array/,
  );
});

test("normaliseArgs: rejects strings with the typeof in the message", () => {
  assert.throws(() => normaliseArgs("not an object", "gh.x"), /got string/);
});

test("normaliseArgs: rejects numbers", () => {
  assert.throws(() => normaliseArgs(42, "gh.x"), /got number/);
});

test("normaliseArgs: rejects booleans", () => {
  assert.throws(() => normaliseArgs(true, "gh.x"), /got boolean/);
});
