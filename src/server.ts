// src/server.ts
//
// MCP server entry point. Registers an empty tool list at v0.1 bootstrap;
// MCP-2 (auth + gh.test_connection) and MCP-3 (GraphQL client) layer real
// tools on top via a registerTool() pattern that the future tool modules
// will call. Keeping the bootstrap minimal means the CI build step
// always has something to publish even when no tool work has shipped.

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Tool registry. Each entry pairs a JSON-Schema descriptor (returned to
// MCP clients via ListTools) with the handler. Future tool modules
// (MCP-2 onwards) call `registerTool` at module-import time so the
// server.ts file itself stays small. The Map preserves insertion order,
// which keeps ListTools output stable across runs.
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface ToolEntry {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}
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

// Read-only introspection over the registry. Two reasons it exists:
//
//   - Unit tests need an observable signal that registration actually
//     persisted, beyond "the call did not throw". Without this they
//     would pass even if `registerTool` were silently a no-op.
//   - Future operational tooling (e.g. a `gh.list_tools` tool, or a
//     CLI dump for debugging) needs the same view, and a single
//     getter beats every caller poking at module internals.
//
// Insertion order is preserved (Map iteration order), so the result
// also pins the order ListTools will hand back to MCP clients.
export function getRegisteredToolNames(): string[] {
  return Array.from(tools.keys());
}

export async function startServer(): Promise<void> {
  const server = new Server(
    {
      name: "@ctxr/mcp-github",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(tools.entries()).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = tools.get(name);
    if (!entry) {
      throw new Error(`mcp-github: unknown tool '${name}'`);
    }
    const result = await entry.handler(args ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Direct-run guard so this module can also be imported by tests
// without spinning up the stdio transport. We compare the canonical
// file:// URL of process.argv[1] against this module's import.meta.url:
// going through `pathToFileURL(resolve(...))` yields the percent-encoded,
// drive-aware form Node uses internally, which a naive
// `file://${argv[1]}` template (with raw spaces, backslashes, or
// duplicated leading slashes from absolute paths) would not match.
const argv1 = process.argv[1];
const isDirectRun =
  typeof argv1 === "string" &&
  argv1.length > 0 &&
  pathToFileURL(resolvePath(argv1)).href === import.meta.url;
if (isDirectRun) {
  startServer().catch((err) => {
    process.stderr.write(`mcp-github fatal: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
