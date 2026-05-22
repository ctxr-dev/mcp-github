// src/tools/workflow/index.ts
//
// Aggregator for the four gh.workflow_* tools. Differs from the
// other domain aggregators in that the registrar takes
// `authedRequest` (REST) rather than `graphql`: GitHub's GraphQL
// coverage of Actions is incomplete, with no cancel mutation
// and weak filter surface on the run list (see ./_shared.ts).

import type { AuthedRequest } from "../../auth/octokit.js";
import type { ToolEntry } from "../../registry.js";
import { registerWorkflowRunCancelTool } from "./run_cancel.js";
import { registerWorkflowRunJobsTool } from "./run_jobs.js";
import { registerWorkflowRunViewTool } from "./run_view.js";
import { registerWorkflowRunsListTool } from "./runs_list.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerWorkflowTools(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  registerWorkflowRunsListTool(register, authedRequest);
  registerWorkflowRunViewTool(register, authedRequest);
  registerWorkflowRunCancelTool(register, authedRequest);
  registerWorkflowRunJobsTool(register, authedRequest);
}
