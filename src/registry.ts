// src/registry.ts
//
// Tool registry + helpers used by `src/server.ts` and the per-tool
// modules under `src/tools/**`. Lives in its own module (not in
// `server.ts`) for two reasons:
//
//   - The package's `exports` map exposes only `dist/server.js` to
//     consumers. Anything `export`ed from `server.ts` becomes part of
//     the public API surface and is therefore a semver commitment.
//     Keeping the registry helpers here lets the unit tests import
//     them via direct file:// URLs against the source tree without
//     the same exports binding consumers.
//   - Tool modules under `src/tools/**` need `registerTool` without
//     having to import from `server.ts`, which would form a cycle
//     (server.ts → tools/x → server.ts) once any tool registers at
//     module-import time.
//
// Nothing in this file is part of the published API. Names beginning
// with `_` are test-only hooks and may change without a release note.

import { toPublicInputSchema } from "./validation/advertise.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolEntry {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

// Map preserves insertion order, which pins the order ListTools
// hands back to MCP clients.
const tools = new Map<string, ToolEntry>();

export function registerTool(name: string, entry: ToolEntry): void {
  if (tools.has(name)) {
    // Re-registering the same name is almost always a typo or a
    // missed renaming. Surface it loudly at startup time rather than
    // silently overwriting the prior handler.
    throw new Error(`mcp-github: tool '${name}' is already registered`);
  }
  tools.set(name, entry);
}

export function getRegisteredToolNames(): string[] {
  return Array.from(tools.keys());
}

export function listToolDescriptors(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return Array.from(tools.entries()).map(([name, t]) => ({
    name,
    description: t.description,
    // Strip top-level oneOf/allOf/anyOf from the ADVERTISED schema.
    // ajv still enforces them at call time via each handler's
    // validate() call. See validation/advertise.ts for why.
    inputSchema: toPublicInputSchema(t.inputSchema),
  }));
}

export function getToolEntry(name: string): ToolEntry | undefined {
  return tools.get(name);
}

// Validate the `arguments` payload from a CallTool request. The MCP
// protocol allows it to be omitted (undefined) or null, both of which
// we coerce to an empty object so handlers can rely on object syntax.
// Anything else (array, string, number, etc.) is rejected with a
// protocol error rather than silently passed through — a handler
// reading `args.foo` off a string would throw a less actionable
// `TypeError` later.
export function normaliseArgs(
  args: unknown,
  toolName: string,
): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error(
      `mcp-github: tool '${toolName}' expected an object 'arguments' payload, got ${typeof args === "object" ? "array" : typeof args}`,
    );
  }
  return args as Record<string, unknown>;
}

// Test-only: clear every registered tool so the unit suite can
// reset module-level registry state between cases. The registry is a
// single Map for the lifetime of the test process, so without this
// hook each test would inherit the entries left behind by the
// previous one.
export function _resetRegistry(): void {
  tools.clear();
}
