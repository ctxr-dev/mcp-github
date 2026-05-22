// src/tools/org/issue_type_create.ts
//
// `gh.org_issue_type_create` — create a new native Issue Type on
// an org via the `createIssueType` GraphQL mutation. Requires
// `admin:org` scope. Used by the methodology's optional
// auto-create flow (`label-taxonomy.md`) when the user wants
// org-wide native types rather than label-based proxies.
//
// The user-facing color is the lowercase form (gray, blue, ...)
// so the input shape matches what `gh.org_issue_types_list`
// returns; the mutation requires the uppercase GraphQL enum, so
// we translate at the boundary via `toGraphqlColor`.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueTypeColor,
  fromGraphqlColor,
  issueTypeColorSchema,
  lookupOrgNodeId,
  orgLoginSchema,
  toGraphqlColor,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["org", "name"],
  properties: {
    org: orgLoginSchema,
    name: { type: "string", minLength: 1 },
    color: issueTypeColorSchema,
    description: { type: "string" },
    is_enabled: {
      type: "boolean",
      description: "Default true; pass false to create a disabled type.",
    },
  },
  additionalProperties: false,
} as const;

// Output shape mirrors the GraphQL `IssueType` fields available
// off the createIssueType mutation. Note this differs from the
// REST `IssueTypeSummary` shape (no created_at/updated_at from
// the mutation), so we expose a slimmer summary here.
const outputSchema = {
  type: "object",
  required: ["id", "name", "color", "description", "is_enabled"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    color: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    is_enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  org: string;
  name: string;
  color?: IssueTypeColor;
  description?: string;
  is_enabled?: boolean;
}

interface Output {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  is_enabled: boolean;
}

interface RawIssueTypeNode {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  isEnabled: boolean;
}

interface CreateResponse {
  createIssueType: {
    issueType: RawIssueTypeNode;
  };
}

export function registerOrgIssueTypeCreateTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.org_issue_type_create", {
    description:
      "Create a native Issue Type on an organisation via the " +
      "`createIssueType` GraphQL mutation. Requires `admin:org` " +
      "scope. Returns the new type's GraphQL node id — capture it " +
      "and pass to `gh.issue_set_issue_type` to apply on issues. " +
      "Color accepts the lowercase form returned by " +
      "`gh.org_issue_types_list` (gray, blue, green, yellow, " +
      "orange, red, pink, purple).",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.org_issue_type_create input",
      );
      const ownerId = await lookupOrgNodeId(
        graphql,
        args.org,
        "gh.org_issue_type_create",
      );
      // Build the mutation input incrementally so unset fields
      // stay absent rather than serialised as explicit null,
      // which GraphQL rejects on optional-of-strict-string
      // fields.
      const input: Record<string, unknown> = {
        ownerId,
        name: args.name,
      };
      if (args.color !== undefined) input.color = toGraphqlColor(args.color);
      if (args.description !== undefined) input.description = args.description;
      if (args.is_enabled !== undefined) input.isEnabled = args.is_enabled;
      const data = await graphql<CreateResponse>("org/issue_type_create", {
        input,
      });
      const raw_type = data.createIssueType.issueType;
      const out: Output = {
        id: raw_type.id,
        name: raw_type.name,
        color: fromGraphqlColor(raw_type.color),
        description: raw_type.description,
        is_enabled: raw_type.isEnabled,
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.org_issue_type_create output",
      );
    },
  });
}
