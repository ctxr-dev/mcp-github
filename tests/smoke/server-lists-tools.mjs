#!/usr/bin/env node
// tests/smoke/server-lists-tools.mjs
//
// End-to-end smoke test: spawn the freshly-built dist/server.mjs
// over stdio, send the MCP `initialize` handshake + `tools/list`,
// assert the registered tool surface. The `EXPECTED_TOOLS` list
// below is the source of truth — update it whenever a new
// domain-tool batch lands. Proves the SDK wiring + auth bootstrap
// + tool registration chain end-to-end without pulling in the
// unit-test framework.
//
// Wire format: the MCP SDK's StdioServerTransport uses newline-
// delimited JSON-RPC (one JSON message per `\n`-terminated line),
// not LSP-style Content-Length framing. Confirmed in the SDK
// source at @modelcontextprotocol/sdk/dist/esm/shared/stdio.js.
//
// Auth: the server runs `resolvePat()` at startup, so we inject a
// fake `GITHUB_TOKEN`. The smoke test never *invokes* a tool — it
// only asks the server to list its tools — so the fake token never
// hits the network; it just satisfies the env-presence check.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "..", "dist", "server.mjs");

const EXPECTED_TOOLS = [
  "gh.test_connection",
  "gh.issue_create",
  "gh.issue_view",
  "gh.issue_list",
  "gh.issue_edit",
  "gh.issue_close",
  "gh.issue_comment",
  "gh.issue_search",
  "gh.issue_add_sub_issue",
  "gh.label_create",
  "gh.label_list",
  "gh.label_edit",
  "gh.label_sync_from_yaml",
  "gh.pr_create",
  "gh.pr_view",
  "gh.pr_list",
  "gh.pr_edit",
  "gh.pr_comment",
  "gh.pr_merge",
  "gh.pr_request_reviews",
  "gh.pr_review_thread_resolve",
  "gh.project_item_add",
  "gh.project_item_update_field",
  "gh.project_field_list",
  "gh.project_items_list",
  "gh.workflow_runs_list",
  "gh.workflow_run_view",
  "gh.workflow_run_cancel",
  "gh.workflow_run_jobs",
  "gh.pr_reviews_list",
  "gh.issue_parent_get",
  "gh.issue_sub_issues_list",
  "gh.org_issue_types_list",
  "gh.pr_review_threads_list",
];

function frame(payload) {
  // Newline-delimited JSON-RPC. JSON.stringify cannot emit a literal
  // `\n`; the trailing `\n` is the message boundary.
  return JSON.stringify(payload) + "\n";
}

function parseFrames(buffer) {
  const messages = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const newlineIdx = buffer.indexOf("\n", cursor);
    if (newlineIdx === -1) break;
    const line = buffer.slice(cursor, newlineIdx).replace(/\r$/, "").trim();
    cursor = newlineIdx + 1;
    if (line.length === 0) continue;
    try {
      messages.push(JSON.parse(line));
    } catch (err) {
      // Defensive: JSON.parse throws SyntaxError, but downstream
      // wrappers (or future Node versions) might surface a non-Error
      // value here. Reading `.message` directly would itself throw
      // and mask the original parse failure.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`smoke: malformed JSON line: ${line.slice(0, 200)}: ${msg}`);
    }
  }
  return { messages, leftover: buffer.slice(cursor) };
}

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    GITHUB_TOKEN: "ghp_smoke_test_fake_token",
  },
});

let buffer = "";
let resolved = false;

const timeout = setTimeout(() => {
  if (resolved) return;
  resolved = true;
  process.stderr.write("smoke: timed out waiting for tools/list response\n");
  child.kill("SIGKILL");
  process.exit(1);
}, 10_000);

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const { messages, leftover } = parseFrames(buffer);
  buffer = leftover;
  for (const m of messages) {
    if (m.id !== 2) continue;
    if (m.error) {
      // The server replied with a JSON-RPC error for our tools/list
      // request. Without this branch the loop would silently ignore
      // it and the test would hang until the 10s timeout, losing the
      // real failure reason. Fail fast and surface the payload.
      const detail = (() => {
        try {
          return JSON.stringify(m.error);
        } catch {
          return String(m.error);
        }
      })();
      process.stderr.write(`smoke FAILED: server returned error for tools/list: ${detail}\n`);
      clearTimeout(timeout);
      resolved = true;
      child.kill("SIGKILL");
      process.exit(1);
    }
    if (m.result) {
      try {
        const { tools } = m.result;
        if (!Array.isArray(tools)) throw new Error("expected tools array");
        const names = tools.map((t) => t.name).sort();
        const expected = [...EXPECTED_TOOLS].sort();
        if (
          names.length !== expected.length ||
          names.some((n, i) => n !== expected[i])
        ) {
          throw new Error(
            `expected tools ${JSON.stringify(expected)}, got ${JSON.stringify(names)}`,
          );
        }
        process.stdout.write(
          `smoke: server lists ${names.length} tool(s) as expected: ${names.join(", ")}\n`,
        );
        clearTimeout(timeout);
        resolved = true;
        child.kill("SIGTERM");
        process.exit(0);
      } catch (err) {
        // Same defensive shape as parseFrames: never assume `err` is
        // an Error instance, since reading `.message` on a non-Error
        // value would mask the original failure with a fresh exception.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`smoke FAILED: ${msg}\n`);
        clearTimeout(timeout);
        resolved = true;
        child.kill("SIGKILL");
        process.exit(1);
      }
    }
  }
});

child.on("exit", (code, signal) => {
  if (resolved) return;
  resolved = true;
  process.stderr.write(`smoke: server exited prematurely (code=${code}, signal=${signal})\n`);
  process.exit(1);
});

child.stdin.write(
  frame({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    },
  }),
);
child.stdin.write(
  frame({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }),
);
child.stdin.write(
  frame({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }),
);
