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
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERIES_ROOT = resolve(HERE, "queries");

// Module-level cache keyed by canonical query name (e.g. `_health/viewer`).
// Only populated under production. In dev we bypass this entirely so
// HMR-style edits surface without a process restart.
const cache = new Map<string, string>();
let initialized = false;

function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

export async function loadQuery(name: string): Promise<string> {
  if (!isProduction()) {
    return readQueryFile(name);
  }
  if (!initialized) {
    await loadAllQueries();
  }
  const cached = cache.get(name);
  if (typeof cached !== "string") {
    throw new Error(
      `mcp-github: unknown GraphQL query '${name}'. ` +
        `Looked under ${QUERIES_ROOT}.`,
    );
  }
  return cached;
}

// Eagerly populate the cache. Exposed for tests + for the server
// startup path that wants to fail fast if the queries directory is
// malformed (rather than at first tool call).
export async function loadAllQueries(): Promise<ReadonlyMap<string, string>> {
  cache.clear();
  let entries: string[];
  try {
    entries = await readdir(QUERIES_ROOT, { recursive: true });
  } catch (err) {
    if (isErrnoNotFound(err)) {
      // No queries directory at all — happens on a fresh checkout
      // before any query files have been added. Cache stays empty;
      // any loadQuery() call will then throw the "unknown query"
      // error, which is the right signal.
      initialized = true;
      return cache;
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
    cache.set(name, contents);
  }
  initialized = true;
  return cache;
}

// Test-only hook: drop the cached state so a fresh `loadAllQueries`
// re-reads the directory. Not exported through the public surface,
// but kept on a separate function so tests can grab it via the
// module's internal namespace if needed.
export function _resetQueryCache(): void {
  cache.clear();
  initialized = false;
}

async function readQueryFile(name: string): Promise<string> {
  const abs = resolve(QUERIES_ROOT, `${name}.graphql`);
  // Defence-in-depth against `..`-traversal in query names. Names
  // come from server-side code (not user input), but the registry
  // is also conceptually a public API; preventing escape from the
  // queries root keeps the surface honest.
  const rel = relative(QUERIES_ROOT, abs);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `mcp-github: query name '${name}' escapes queries root`,
    );
  }
  try {
    return await readFile(abs, "utf8");
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
