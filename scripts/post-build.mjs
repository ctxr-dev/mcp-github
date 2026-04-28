#!/usr/bin/env node
// scripts/post-build.mjs
//
// Post-tsc step: produce `dist/server.mjs` as the executable bin
// shim. tsc emits `dist/server.js` + `dist/server.d.ts` + sourcemaps,
// and we leave them all in place so the importable library entry
// (pointed at by package.json `main`/`types`/`exports`) keeps the
// canonical `.js`/`.d.ts`/`.js.map`/`.d.ts.map` quartet that node,
// TypeScript, and stack-trace tooling expect.
//
// The bin entry in package.json points at `dist/server.mjs` because:
//
//   - The shebang line lets npm install mark it executable on POSIX.
//   - The .mjs suffix is the convention for "definitely ESM" entry
//     points, even when the surrounding package is already module-typed.
//
// The shim itself is a tiny wrapper that imports `startServer` from
// the sibling `./server.js` and only invokes it when the module is
// the process entrypoint. That keeps `npx @ctxr/mcp-github` (and
// `mcp-github` after install) working while avoiding import-time
// side effects when something resolves `dist/server.mjs` as a
// package entry.
//
// Keeping this as a separate script (not inline in the npm build
// script) means the wrapper + chmod treatment is testable and the
// build command stays a single tsc call.

import { writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(__dirname, "..", "dist");
const mjsPath = resolve(distRoot, "server.mjs");

// The direct-run guard compares the canonical file:// URL of
// process.argv[1] against this module's own import.meta.url. Going
// through `pathToFileURL(resolve(...))` yields the percent-encoded,
// normalised, absolute form Node uses internally — a verbatim
// `process.argv[1]` comparison would miss when the entry was
// launched via a relative path, a symlink, or with non-canonical
// path normalisation on Windows.
const SHIM = `#!/usr/bin/env node
import { startServer } from "./server.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  return pathToFileURL(resolve(entry)).href === import.meta.url;
})();

if (isDirectRun) {
  startServer().catch((err) => {
    process.stderr.write(\`mcp-github fatal: \${err?.message ?? String(err)}\\n\`);
    process.exit(1);
  });
}
`;

writeFileSync(mjsPath, SHIM);
// 0o755: rwxr-xr-x, so the npm bin shim that points at this file can
// execute it directly on POSIX. Windows ignores the bit; npm rewrites
// the bin shim to a .cmd file at install time anyway.
chmodSync(mjsPath, 0o755);

process.stdout.write(`mcp-github: dist/server.mjs ready\n`);
