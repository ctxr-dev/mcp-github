// src/tools/project/index.ts
//
// Aggregator for the four gh.project_* tools. Imported by
// `src/server.ts`'s startServer() and called once at boot to
// register every Project v2 tool against the registry.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerProjectFieldListTool } from "./field_list.js";
import { registerProjectItemAddTool } from "./item_add.js";
import { registerProjectItemUpdateFieldTool } from "./item_update_field.js";
import { registerProjectItemsListTool } from "./items_list.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerProjectTools(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  registerProjectItemAddTool(register, graphql);
  registerProjectItemUpdateFieldTool(register, graphql);
  registerProjectFieldListTool(register, graphql);
  registerProjectItemsListTool(register, graphql);
}
