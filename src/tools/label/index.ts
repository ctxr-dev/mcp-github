// src/tools/label/index.ts
//
// Aggregator for the four gh.label_* tools. Imported by
// `src/server.ts`'s startServer() and called once at boot.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerLabelCreateTool } from "./create.js";
import { registerLabelEditTool } from "./edit.js";
import { registerLabelListTool } from "./list.js";
import { registerLabelSyncFromYamlTool } from "./sync_from_yaml.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerLabelTools(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  registerLabelCreateTool(register, graphql);
  registerLabelListTool(register, graphql);
  registerLabelEditTool(register, graphql);
  registerLabelSyncFromYamlTool(register, graphql);
}
