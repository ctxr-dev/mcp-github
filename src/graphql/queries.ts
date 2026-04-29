// src/graphql/queries.ts
//
// Query loader. Resolves a query name like `auth/viewer` to the
// contents of the matching `.graphql` file under
// `src/graphql/queries/<group>/<name>.graphql` (or the parallel path
// in dist after build). Names are deliberately path-shaped so the
// directory layout is also the registry: a new query is just a new
// file, no central manifest to update.
//
// Caching policy:
//
//   - production (NODE_ENV === "production"): the first call eagerly
//     loads every query in the queries directory and caches it. Later
//     calls hit the cache.
//   - development (anything else): each call re-reads the file from
//     disk so editing a `.graphql` file produces immediate feedback
//     without restarting the server.
//
// At v0.1 the queries directory is intentionally near-empty: queries
// land alongside the tools that consume them (MCP-4 onwards). The
// `_health/viewer.graphql` placeholder is the canonical "is the
// pipeline working?" smoke target and is exercised by the unit tests.

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, posix } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERIES_ROOT = resolve(HERE, "queries");

// Module-level cache keyed by canonical query name (e.g. `_health/viewer`).
// Populated by `loadAllQueries()` / `ensureInitialized()`. In production
// `loadQuery` reads from this cache. In development `loadQuery`
// bypasses it and re-reads from disk per call so HMR-style edits
// surface without a process restart, but `loadAllQueries()` (used by
// the unit tests and the prod startup-validation path) still
// populates the cache regardless of mode.
let cache = new Map<string, string>();

// Single shared init promise so concurrent loadQuery() calls don't
// each kick off their own loadAllQueries() and fight over the shared
// cache mid-flight. The first call creates the promise; later
// callers await the same one and observe a fully-populated cache.
// `null` means uninitialised; once set, the value sticks until
// `_resetQueryCache()` clears it.
let initPromise: Promise<ReadonlyMap<string, string>> | null = null;

// Test-only counter so the production-cache test can verify the
// caching contract in observable terms (file reads happen at most
// once per query across calls), instead of just asserting that two
// calls return equal contents — which would also pass on the dev
// path or under a regression that re-reads on every call.
let diskReadCount = 0;
export function _getDiskReadCount(): number {
  return diskReadCount;
}

// Test-only override for the dev/prod switch. Node's test runner
// executes tests concurrently by default, so the production-cache-path
// test flipping `process.env.NODE_ENV` directly would race other
// tests in this file (and conflict with the repo's stated approach of
// not mutating process.env in tests). The override is module-scoped
// and reset alongside the cache by `_resetQueryCache()`.
let productionOverride: boolean | undefined;
export function _setProductionOverride(value: boolean | undefined): void {
  productionOverride = value;
}

function isProduction(): boolean {
  if (productionOverride !== undefined) return productionOverride;
  return process.env["NODE_ENV"] === "production";
}

export async function loadQuery(name: string): Promise<string> {
  // Normalise the caller-supplied name to the canonical posix
  // shape: convert backslashes to forward slashes, then collapse
  // ".", "..", and duplicate slashes via posix.normalize. Without
  // this, dev (which goes through the filesystem and benefits from
  // path.resolve's own normalisation) would happily resolve names
  // like `x/../_health/viewer` while prod (a literal cache lookup
  // by string key) would miss. Both paths now agree on the same
  // canonical key shape.
  const canonical = canonicaliseQueryName(name);
  if (!isProduction()) {
    return readQueryFile(canonical);
  }
  // ensureInitialized routes every concurrent caller through the same
  // promise. After it resolves the cache is populated and we can
  // serve all subsequent loadQuery calls in O(1) without ever
  // touching the filesystem.
  await ensureInitialized();
  const cached = cache.get(canonical);
  if (typeof cached !== "string") {
    throw new Error(
      `mcp-github: unknown GraphQL query '${canonical}'. ` +
        `Looked under ${QUERIES_ROOT}.`,
    );
  }
  return cached;
}

// Posix-normalise a query name and reject any form that would
// escape the queries root. Shared by both the dev and prod paths
// so the canonical key shape is identical end-to-end.
function canonicaliseQueryName(name: string): string {
  const slashified = name.replace(/\\/g, "/");
  // posix.normalize collapses "./" and "..", drops duplicate
  // slashes, and is idempotent — exactly the contract we want for
  // a cache key. It does keep leading ".." segments though, so we
  // still need the explicit escape check below.
  const normalized = posix.normalize(slashified);
  if (
    normalized.startsWith("..") ||
    normalized.startsWith("/") ||
    normalized.length === 0 ||
    normalized === "."
  ) {
    throw new Error(
      `mcp-github: query name '${name}' escapes queries root or resolves to empty`,
    );
  }
  return normalized;
}

// Eagerly populate the cache. Exposed for tests + for the server
// startup path that wants to fail fast if the queries directory is
// malformed (rather than at first tool call). Idempotent: subsequent
// calls return the same shared init promise.
export function loadAllQueries(): Promise<ReadonlyMap<string, string>> {
  return ensureInitialized();
}

// Internal: shared-promise initializer. Concurrent callers all get
// the same promise; the underlying `populateCache()` runs at most
// once per cache lifetime.
//
// On rejection (e.g. a transient FS error reading a query file) we
// clear `initPromise` so the next caller can retry. Without this
// reset, a single transient failure would cache the rejected
// promise and poison every subsequent loadQuery() call until the
// process restarts.
function ensureInitialized(): Promise<ReadonlyMap<string, string>> {
  if (initPromise) return initPromise;
  const fresh: Promise<ReadonlyMap<string, string>> = populateCache().catch((err) => {
    // Identity check guards against `_resetQueryCache()` (or another
    // failed caller) clearing/replacing the slot before we observe
    // our own rejection. Only blank the slot if it still holds the
    // exact promise we just attempted.
    if (initPromise === fresh) initPromise = null;
    throw err;
  });
  initPromise = fresh;
  return fresh;
}

async function populateCache(): Promise<ReadonlyMap<string, string>> {
  // Build into a fresh Map and swap it in on success. If a partial
  // populate fails midway (transient FS read error), the swap never
  // happens and `cache` keeps its previous state — there is no
  // "stale half-populated" mid-state visible to readers, and a
  // retry starts from a clean slate.
  const next = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(QUERIES_ROOT, { recursive: true });
  } catch (err) {
    if (isErrnoNotFound(err)) {
      // No queries directory at all — happens on a fresh checkout
      // before any query files have been added. Swap in the empty
      // map so subsequent `loadQuery()` calls observe the absence
      // (they'll throw "unknown query", which is the right signal).
      cache = next;
      return next;
    }
    throw err;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".graphql")) continue;
    const abs = resolve(QUERIES_ROOT, entry);
    const name = entry
      .slice(0, -".graphql".length)
      // Normalise Windows backslashes to forward slashes in the
      // canonical name so queries resolve identically across platforms.
      .replace(/\\/g, "/");
    const contents = await readFile(abs, "utf8");
    diskReadCount += 1;
    next.set(name, contents);
  }
  // Atomic swap on success: prior cache contents are replaced
  // wholesale, so deletions in the queries directory propagate.
  cache = next;
  return next;
}

// Test-only hook: drop the cached state so a fresh init re-reads
// the directory. Also clears the production-mode override and the
// disk-read counter so each test starts from a known state. Not
// exported through the public surface, but kept on a separate function
// so tests can grab it via the module's internal namespace if needed.
export function _resetQueryCache(): void {
  cache = new Map<string, string>();
  initPromise = null;
  productionOverride = undefined;
  diskReadCount = 0;
}

async function readQueryFile(name: string): Promise<string> {
  const abs = resolve(QUERIES_ROOT, `${name}.graphql`);
  // Defence-in-depth against `..`-traversal in query names. Names
  // come from server-side code (not user input), but the registry
  // is also conceptually a public API; preventing escape from the
  // queries root keeps the surface honest.
  //
  // The `isAbsolute(rel)` check is the Windows-cross-drive case: when
  // `abs` lives on a different drive than `QUERIES_ROOT`,
  // `path.relative()` returns an absolute path (e.g. `D:\\...`)
  // rather than a `..`-prefixed relative one. Just checking the
  // `..` / `/` prefixes would let that through.
  const rel = relative(QUERIES_ROOT, abs);
  if (rel.startsWith("..") || rel.startsWith("/") || isAbsolute(rel)) {
    throw new Error(
      `mcp-github: query name '${name}' escapes queries root`,
    );
  }
  try {
    const contents = await readFile(abs, "utf8");
    diskReadCount += 1;
    return contents;
  } catch (err) {
    if (isErrnoNotFound(err)) {
      throw new Error(
        `mcp-github: unknown GraphQL query '${name}'. ` +
          `Looked at ${abs}.`,
      );
    }
    throw err;
  }
}

function isErrnoNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
