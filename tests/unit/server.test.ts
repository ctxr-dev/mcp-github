// tests/unit/server.test.ts
//
// Unit tests for the tool-registry surface in src/server.ts. The full
// stdio handshake is exercised in tests/smoke/server-lists-zero-tools.mjs
// (an end-to-end test against the built dist/); these tests pin the
// in-memory registry behaviour: registration, duplicate rejection, and
// listing order.

import { test } from "node:test";
import assert from "node:assert/strict";

// We re-import server.ts in each test to reset the module-level
// registry between cases (Node's test runner shares module scope by
// default; for the v0.1 surface a fresh import is cheaper than a
// reset hook). The dynamic import + cache-bust query keeps the
// re-import deterministic.
async function freshServerModule() {
  const url = new URL("../../src/server.ts", import.meta.url);
  url.search = `?t=${Date.now()}-${Math.random()}`;
  return import(url.href);
}

test("registerTool: stores the tool under its name", async () => {
  const mod = await freshServerModule();
  mod.registerTool("gh.example", {
    description: "Example tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true }),
  });
  // Use the public introspection helper so the assertion catches a
  // hypothetical future regression where registration is silently a
  // no-op (which a "no throw" assertion would not).
  assert.deepEqual(mod.getRegisteredToolNames(), ["gh.example"]);
});

test("registerTool: rejects a duplicate name", async () => {
  const mod = await freshServerModule();
  const entry = {
    description: "Example",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({}),
  };
  mod.registerTool("gh.dup", entry);
  // Re-registering the same name surfaces a typo / missed-rename
  // immediately rather than silently shadowing the prior handler,
  // which would be very hard to debug at runtime.
  assert.throws(() => mod.registerTool("gh.dup", entry), /already registered/);
});

test("registerTool: many tools coexist and preserve insertion order", async () => {
  const mod = await freshServerModule();
  const expected: string[] = [];
  for (let i = 0; i < 10; i++) {
    const name = `gh.tool_${i}`;
    mod.registerTool(name, {
      description: `Tool ${i}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ i }),
    });
    expected.push(name);
  }
  // Verify every name made it in, and in registration order — Map
  // iteration order pins the ListTools response so a refactor that
  // swaps the storage to anything unordered must surface here.
  assert.deepEqual(mod.getRegisteredToolNames(), expected);
});
