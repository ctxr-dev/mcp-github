#!/usr/bin/env node
// scripts/post-build.mjs
//
// Post-tsc step: rename dist/server.js -> dist/server.mjs and prepend a
// shebang. The bin entry in package.json points at server.mjs, but tsc
// emits .js (we use ESM with `type: module`, so .js is already ESM,
// but a .mjs extension is the convention for "definitely ESM" + lets
// us ship a `#!/usr/bin/env node` line that npm makes executable on
// install. Keeping this as a separate script (not inline in the npm
// build script) means the rename + shebang treatment is testable and
// the build command stays a single tsc call.

import { readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(__dirname, "..", "dist");
const jsPath = resolve(distRoot, "server.js");
const mjsPath = resolve(distRoot, "server.mjs");

const SHEBANG = "#!/usr/bin/env node\n";

const original = readFileSync(jsPath, "utf8");
// Avoid double-shebang if the source ever grows one for some reason
// (TypeScript currently strips them, but defending here keeps the
// rename idempotent under unusual configs).
const withShebang = original.startsWith("#!")
  ? original
  : SHEBANG + original;

writeFileSync(mjsPath, withShebang);
// 0o755: rwxr-xr-x, so the npm bin shim that points at this file can
// execute it directly on POSIX. Windows ignores the bit; npm rewrites
// the bin shim to a .cmd file at install time anyway.
chmodSync(mjsPath, 0o755);

// Remove the unprefixed copy so consumers cannot accidentally import
// a different file shape via require/resolve heuristics.
try {
  renameSync(jsPath, jsPath + ".pretranspile");
  // Use the rename as the delete signal: if the rename succeeded we
  // know we have ownership of the file; the leftover ".pretranspile"
  // is then unlinked. Two-step keeps a single failure path (rename)
  // instead of unlink-then-recover.
  const { unlinkSync } = await import("node:fs");
  unlinkSync(jsPath + ".pretranspile");
} catch {
  // best-effort; if dist/server.js is gone (e.g. someone else cleaned
  // it) the rename above already produced the canonical .mjs and the
  // user can ignore this branch.
}

process.stdout.write(`mcp-github: dist/server.mjs ready\n`);
