#!/usr/bin/env node
// tests/smoke/server-lists-zero-tools.mjs
//
// End-to-end smoke test: spawn the freshly-built dist/server.mjs over
// stdio, send the MCP `initialize` handshake + `tools/list`, assert
// the server responds with an empty tools array. Proves at v0.1
// bootstrap that the SDK wiring is correct end-to-end without
// pulling in the full unit-test framework.
//
// Wire format: the MCP SDK's StdioServerTransport uses newline-
// delimited JSON-RPC (one JSON message per `\n`-terminated line),
// not LSP-style Content-Length framing. Confirmed in the SDK
// source at @modelcontextprotocol/sdk/dist/esm/shared/stdio.js.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "..", "dist", "server.mjs");

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
    if (m.id === 2 && m.result) {
      try {
        const { tools } = m.result;
        if (!Array.isArray(tools)) throw new Error("expected tools array");
        if (tools.length !== 0) {
          throw new Error(`expected 0 tools at v0.1 bootstrap, got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
        }
        process.stdout.write("smoke: server lists 0 tools as expected\n");
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
