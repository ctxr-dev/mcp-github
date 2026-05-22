// src/tools/org/index.ts
//
// Aggregator for the gh.org_* tools. Like the workflow group, the
// registrar takes `authedRequest` (REST) plus `graphql` because
// native Issue Type mutations live on GraphQL while the listing
// endpoint is REST-only. v0.1 of this group exposes a single
// REST list tool; the create + assign mutations (A5) layer on
// top.

import type { AuthedRequest } from "../../auth/octokit.js";
import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { registerOrgIssueTypesListTool } from "./issue_types_list.js";

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

export function registerOrgTools(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
  // graphql is unused at the moment but the signature anticipates
  // A5's `org_issue_type_create` GraphQL mutation. Keeping the
  // parameter here avoids a churn-y signature change one PR later.
  _graphql: GraphqlClient,
): void {
  registerOrgIssueTypesListTool(register, authedRequest);
}
