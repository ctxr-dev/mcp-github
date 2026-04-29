#!/usr/bin/env node
// scripts/run-tests.mjs
//
// Cross-platform unit/integration test runner. Exists because:
//
//   - npm scripts run via /bin/sh on POSIX and cmd.exe on Windows;
//     bash-only constructs like `shopt -s globstar` are not portable.
//   - Node's `--test path/` mode resolves the path as a module
//     (ERR_MODULE_NOT_FOUND for a directory), so we can't just hand
//     `node --test ./tests/unit` to the test runner.
//   - Node's bare `--test` (no args) discovers tests under CWD but
//     can't be scoped to a subdirectory like `tests/unit/` without
//     also picking up `tests/integration/`.
//
// We do the directory walk ourselves with `fs.readdir(..., { recursive: true })`
// (stable on Node 22+) and pass the resulting file list straight to a
// child `node --test`. Same shape on every OS.
//
// Usage:
//   node scripts/run-tests.mjs unit          # tests/unit/**/*.test.ts
//   node scripts/run-tests.mjs integration   # tests/integration/**/*.test.ts
//
// The integration variant also sets GITHUB_PAT_LIVE=1 so opt-in
// integration tests know they have permission to call GitHub.

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const target = process.argv[2];
if (target !== "unit" && target !== "integration") {
  process.stderr.write(`run-tests: expected "unit" or "integration", got: ${target ?? "<none>"}\n`);
  process.exit(2);
}

const testDir = resolve(repoRoot, "tests", target);

async function findTestFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { recursive: true });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((e) => e.endsWith(".test.ts"))
    .map((e) => join(root, e))
    .map((p) => (sep === "\\" ? p.replace(/\\/g, "/") : p));
}

const files = await findTestFiles(testDir);
if (files.length === 0) {
  process.stderr.write(`run-tests: no *.test.ts files under ${testDir}\n`);
  // Unit suite should always have tests; integration suite is allowed
  // to be empty (it's opt-in and may be skipped in CI without a token).
  process.exit(target === "unit" ? 1 : 0);
}

const env = { ...process.env };
if (target === "integration") {
  env.GITHUB_PAT_LIVE = "1";
}

const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=spec", "--import", "tsx", ...files],
  { stdio: "inherit", env },
);

// Without an "error" handler, a failure to spawn the child (EACCES,
// missing executable, permission errors) emits a default unhandled
// "error" event with a stack trace. We surface a concise script-level
// failure instead so the npm-run-script log isn't a wall of internals.
child.on("error", (err) => {
  process.stderr.write(`run-tests: failed to start child process: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`run-tests: child terminated by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
