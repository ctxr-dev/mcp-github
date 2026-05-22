// src/tools/issue/index.ts
//
// Aggregator for the gh.issue_* tools. Imported by
// `src/server.ts`'s `startServer()` and called once at boot to
// register every issue-domain tool against the registry. Each
// individual tool lives in its own file to keep the per-tool
// schemas + handlers manageable; this file just orchestrates.
// The authoritative list is the function body below — no
// hard-coded count in this header so it doesn't drift each time
// a tool joins or leaves the group.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerIssueAddSubIssueTool } from "./add_sub_issue.js";
import { registerIssueCloseTool } from "./close.js";
import { registerIssueCommentTool } from "./comment.js";
import { registerIssueCreateTool } from "./create.js";
import { registerIssueEditTool } from "./edit.js";
import { registerIssueListTool } from "./list.js";
import { registerIssueSearchTool } from "./search.js";
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
  registerIssueAddSubIssueTool(register, graphql);
}
