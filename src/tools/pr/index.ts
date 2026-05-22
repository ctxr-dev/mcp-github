// src/tools/pr/index.ts
//
// Aggregator for the gh.pr_* tools. Imported by
// `src/server.ts`'s startServer() and called once at boot to
// register every PR-domain tool against the registry. The
// function body below is the authoritative list — no hard-coded
// count in this header so it doesn't drift each time a tool
// joins or leaves the group.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerPRCommentTool } from "./comment.js";
import { registerPRCreateTool } from "./create.js";
import { registerPREditTool } from "./edit.js";
import { registerPRListTool } from "./list.js";
import { registerPRMergeTool } from "./merge.js";
import { registerPRRequestReviewsTool } from "./request_reviews.js";
import { registerPRReviewsListTool } from "./reviews_list.js";
import { registerPRViewTool } from "./view.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerPRTools(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  registerPRCreateTool(register, graphql);
  registerPRViewTool(register, graphql);
  registerPRListTool(register, graphql);
  registerPREditTool(register, graphql);
  registerPRCommentTool(register, graphql);
  registerPRMergeTool(register, graphql);
  registerPRRequestReviewsTool(register, graphql);
  registerPRReviewsListTool(register, graphql);
}
