// tests/unit/graphql/queries.test.ts
//
// Tests the query loader. We point the loader at the *real*
// queries directory under `src/graphql/queries/` (rather than a
// synthetic fixture tree) so we exercise the actual on-disk
// layout the runtime uses. The `_health/viewer.graphql` file
// is the seeded placeholder we depend on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadQuery,
  loadAllQueries,
  _resetQueryCache,
} from "../../../src/graphql/queries.ts";

// Reset the in-process cache between tests so production-mode
// caching doesn't leak across cases. The dev path (default
// NODE_ENV) re-reads from disk on every call and is unaffected.
function freshCache() {
  _resetQueryCache();
}

test("loadQuery: resolves a known name to file contents (dev path)", async () => {
  freshCache();
  const q = await loadQuery("_health/viewer");
  assert.match(q, /viewer/);
  assert.match(q, /login/);
});

test("loadQuery: throws a structured error for an unknown name (dev path)", async () => {
  freshCache();
  await assert.rejects(
    loadQuery("not_a_real_group/no_such_query"),
    /unknown GraphQL query 'not_a_real_group\/no_such_query'/,
  );
});

test("loadQuery: rejects names that try to escape the queries root", async () => {
  freshCache();
  await assert.rejects(
    loadQuery("../auth/pat"),
    /escapes queries root/,
  );
});

test("loadAllQueries: indexes the canonical placeholder", async () => {
  freshCache();
  const all = await loadAllQueries();
  // We don't pin the full set (queries land per tool in later PRs),
  // but the bootstrap placeholder must be present — it's the entry
  // point for the integration smoke probe in MCP-12.
  assert.ok(all.has("_health/viewer"), `expected _health/viewer in ${[...all.keys()].join(", ")}`);
});

test("loadQuery: production path serves from the cache after first init", async () => {
  freshCache();
  const original = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    // Two sequential loads should both succeed and return identical
    // contents; in prod mode the second call goes through the cache.
    const a = await loadQuery("_health/viewer");
    const b = await loadQuery("_health/viewer");
    assert.equal(a, b);
    assert.match(a, /viewer/);
  } finally {
    if (original === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = original;
    }
    freshCache();
  }
});
