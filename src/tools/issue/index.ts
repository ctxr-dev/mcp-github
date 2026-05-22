// src/tools/issue/index.ts
//
// Aggregator for the seven `gh.issue_*` tools. Imported by
// `src/server.ts`'s `startServer()` and called once at boot to
// register every issue-domain tool against the registry. Each
// individual tool lives in its own file to keep the per-tool
// schemas + handlers manageable; this file just orchestrates.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerIssueCloseTool } from "./close.js";
import { registerIssueCommentTool } from "./comment.js";
import { registerIssueCreateTool } from "./create.js";
import { registerIssueEditTool } from "./edit.js";
import { registerIssueListTool } from "./list.js";
import { registerIssueParentGetTool } from "./parent_get.js";
import { registerIssueSearchTool } from "./search.js";
import { registerIssueSubIssuesListTool } from "./sub_issues_list.js";
import { registerIssueViewTool } from "./view.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerIssueTools(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  registerIssueCreateTool(register, graphql);
  registerIssueViewTool(register, graphql);
  registerIssueListTool(register, graphql);
  registerIssueEditTool(register, graphql);
  registerIssueCloseTool(register, graphql);
  registerIssueCommentTool(register, graphql);
  registerIssueSearchTool(register, graphql);
  registerIssueParentGetTool(register, graphql);
  registerIssueSubIssuesListTool(register, graphql);
}
