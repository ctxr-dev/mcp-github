// src/server.ts
//
// MCP server entry point. Registers an empty tool list at v0.1 bootstrap;
// MCP-2 (auth + gh.test_connection) and MCP-3 (GraphQL client) layer real
// tools on top via a registerTool() pattern that the future tool modules
// will call. Keeping the bootstrap minimal means the CI build step
// always has something to publish even when no tool work has shipped.

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
// without spinning up the stdio transport. The conventional check
// (process.argv[1] equals this file) is replaced with the
// import.meta.url comparison that survives bin-shim launching.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  startServer().catch((err) => {
    process.stderr.write(`mcp-github fatal: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
