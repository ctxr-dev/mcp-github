// src/server.ts
//
// MCP server entry point. The package's `exports` map points
// consumers at this module, so the public API surface is only what's
// `export`ed here: at v0.1 bootstrap that's `startServer` (called by
// the bin shim). Tool registry helpers + the request handlers live
// in the local `registry` module (`./registry`), which is
// intentionally NOT part of the public API — tests import it
// directly from source. The `.js` import specifier below is the
// canonical ESM extension TypeScript preserves into the dist tree;
// the source file is `src/registry.ts`.
//
// MCP-2 layers PAT resolution + auth-aware tool registration into
// `startServer()`. Real domain tools land in MCP-3 onwards.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { resolvePat } from "./auth/pat.js";
import { createAuthedRequest } from "./auth/octokit.js";
import { createGraphqlClient } from "./graphql/client.js";
import {
  getToolEntry,
  listToolDescriptors,
  normaliseArgs,
  registerTool,
} from "./registry.js";
import { registerTestConnectionTool } from "./tools/auth/test_connection.js";
import { registerIssueTools } from "./tools/issue/index.js";
import { registerLabelTools } from "./tools/label/index.js";
import { registerPRTools } from "./tools/pr/index.js";
import { registerProjectTools } from "./tools/project/index.js";

// Read the package version from the package.json next to the dist
// tree at startup, so a single source of truth (package.json) drives
// the version reported in MCP `initialize` responses. Reading from
// disk once at boot avoids hardcoding a version string that drifts
// every time `npm version` bumps the package.
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/server.js → ../package.json. Works both during local builds
  // (the repo's package.json sits one level up from dist/) and after
  // an `npm install` (npm places package.json at the package root,
  // also one level up from the dist tree).
  const pkgPath = resolve(here, "..", "package.json");
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new Error(
      `mcp-github: package.json at ${pkgPath} has no \`version\` string`,
    );
  }
  return raw.version;
}

export async function startServer(): Promise<void> {
  // Resolve the PAT and wire up the authed Octokit clients before
  // registering any auth-aware tools. resolvePat() throws
  // MissingPatError when no env var is set, which bubbles up to the
  // bin shim (`dist/server.mjs`) so startup fails fast instead of
  // partially initialising the server without authentication. The
  // shim writes the message to stderr (prefixed with `mcp-github
  // fatal:`) and exits non-zero — currently 1 for any startup error,
  // including auth misses.
  const pat = resolvePat();
  const authedRequest = createAuthedRequest(pat);
  // Build the canonical GraphQL client once and hand it to every
  // domain-tool registrar. Tools never construct their own client;
  // sharing a single instance preserves the rate-limit policy state
  // across calls and keeps the dependency arrow one-way:
  // server.ts → tools/**, never tools/** → server.ts.
  const graphql = createGraphqlClient(authedRequest);
  registerTestConnectionTool(registerTool, authedRequest);
  registerIssueTools(registerTool, graphql);
  registerLabelTools(registerTool, graphql);
  registerPRTools(registerTool, graphql);
  registerProjectTools(registerTool, graphql);

  const server = new Server(
    {
      name: "@ctxr/mcp-github",
      version: readPackageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDescriptors(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = getToolEntry(name);
    if (!entry) {
      throw new Error(`mcp-github: unknown tool '${name}'`);
    }
    // Tool handlers are typed against `Record<string, unknown>`, but
    // the SDK's `request.params.arguments` is `unknown` — anything
    // serialisable as JSON can land here (array, primitive, null,
    // even undefined). normaliseArgs coerces undefined/null to `{}`
    // and rejects the rest with a clean protocol error.
    const handlerArgs = normaliseArgs(args, name);
    const result = await entry.handler(handlerArgs);
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

// No direct-run guard here. The bin shim at `dist/server.mjs`
// (generated by scripts/post-build.mjs) is the only entry point that
// invokes startServer(); this module is purely a library.
