// src/tools/org/index.ts
//
// Aggregator for the gh.org_* tools. Like the workflow group, the
// registrar takes `authedRequest` (REST) plus `graphql` because
// native Issue Type mutations live on GraphQL while the listing
// endpoint is REST-only.

import type { AuthedRequest } from "../../auth/octokit.js";
import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerOrgIssueTypeCreateTool } from "./issue_type_create.js";
import { registerOrgIssueTypesListTool } from "./issue_types_list.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerOrgTools(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
  graphql: GraphqlClient,
): void {
  registerOrgIssueTypesListTool(register, authedRequest);
  registerOrgIssueTypeCreateTool(register, graphql);
}
