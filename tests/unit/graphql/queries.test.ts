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
  _setProductionOverride,
  _getDiskReadCount,
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
  // Use the module-scoped production override rather than mutating
  // process.env.NODE_ENV. Node's test runner runs tests concurrently,
  // and a global env mutation here would race the dev-path tests
  // above; the override flips just this one module's switch.
  //
  // The disk-read counter is the actual caching contract. Asserting
  // only that two calls return equal strings would also pass on the
  // dev path (which re-reads on each call) — that's the failure mode
  // the round-3 review flagged. Counting reads pins the cache.
  freshCache();
  _setProductionOverride(true);
  try {
    const beforeCount = _getDiskReadCount();
    const a = await loadQuery("_health/viewer");
    const afterFirst = _getDiskReadCount();
    const b = await loadQuery("_health/viewer");
    const afterSecond = _getDiskReadCount();
    assert.equal(a, b);
    assert.match(a, /viewer/);
    assert.ok(
      afterFirst > beforeCount,
      "first call must hit disk to populate the cache",
    );
    assert.equal(
      afterSecond,
      afterFirst,
      "second call must hit the cache, not disk",
    );
  } finally {
    // freshCache() also clears the override, but we belt-and-brace it
    // so a future change that splits cache-reset from override-reset
    // doesn't leak prod mode into later tests.
    _setProductionOverride(undefined);
    freshCache();
  }
});

test("loadQuery: production path is concurrency-safe (single shared init)", async () => {
  // Three concurrent calls to loadQuery in production mode must all
  // resolve correctly and must NOT each trigger their own
  // cache-population pass. Without the shared init promise, a clear+
  // rebuild race could leave one of the callers observing an empty
  // cache and throwing a spurious "unknown query" error.
  freshCache();
  _setProductionOverride(true);
  try {
    // Derive the expected read count from the actual queries
    // directory rather than hardcoding a constant. A pre-loaded
    // peek at loadAllQueries() gives the real number of .graphql
    // files; we then reset and run the concurrent workload.
    const probe = await loadAllQueries();
    const expectedFiles = probe.size;
    freshCache();
    _setProductionOverride(true);

    const beforeCount = _getDiskReadCount();
    const [a, b, c] = await Promise.all([
      loadQuery("_health/viewer"),
      loadQuery("_health/viewer"),
      loadQuery("_health/viewer"),
    ]);
    const afterCount = _getDiskReadCount();
    assert.equal(a, b);
    assert.equal(b, c);
    // All three concurrent callers awaited the same init, so each
    // file is read exactly once across the trio. The total disk
    // reads matches the on-disk file count, not 3 × that count.
    const reads = afterCount - beforeCount;
    assert.equal(
      reads,
      expectedFiles,
      `expected exactly ${expectedFiles} disk reads (one per query file), observed ${reads}`,
    );
  } finally {
    _setProductionOverride(undefined);
    freshCache();
  }
});
