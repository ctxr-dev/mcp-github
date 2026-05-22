// src/tools/org/issue_types_list.ts
//
// `gh.org_issue_types_list` — list the native Issue Types
// configured on an org via REST `GET /orgs/{org}/issue-types`.
// Native Issue Types are GitHub's first-class categorisation
// that the methodology's `label-taxonomy.md` uses instead of
// label-based proxies for type:feature / type:bug / etc.
// Listing requires `read:org`; mutating the org's issue types
// (a separate concern) requires `admin:org`.
//
// REST rather than GraphQL because the endpoint isn't exposed via
// GraphQL at the org level (only on individual Issues, via the
// `issueType` field). The route is too new for
// `@octokit/openapi-types` to type it, so we declare the wire
// shape in `_shared.ts` and pin it via output validation.

import type { AuthedRequest } from "../../auth/octokit.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueTypeSummary,
  type RawIssueType,
  issueTypeSummarySchema,
  orgLoginSchema,
  summariseIssueType,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["org"],
  properties: {
    org: orgLoginSchema,
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["types"],
  properties: {
    types: { type: "array", items: issueTypeSummarySchema },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  org: string;
}

interface Output {
  types: IssueTypeSummary[];
}

export function registerOrgIssueTypesListTool(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  register("gh.org_issue_types_list", {
    description:
      "List native Issue Types configured on an organization. " +
      "Requires `read:org` (and the org must have native Issue " +
      "Types enabled). Returns each type's numeric REST id along " +
      "with name, description, color, and enabled flag. Note: " +
      "the GraphQL mutation that applies a type to an issue " +
      "requires the GraphQL node id, not this numeric id; the " +
      "node id is returned at create time and must be captured " +
      "then.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.org_issue_types_list input",
      );
      // The route isn't in @octokit/openapi-types yet; cast both
      // the route literal and the params through `unknown` so
      // Octokit's per-route narrowing stays out of the way. The
      // path is well-known and documented under
      // `/orgs/{org}/issue-types`.
      const response = await (
        authedRequest as unknown as (
          route: string,
          params: Record<string, unknown>,
        ) => Promise<{ data: unknown }>
      )("GET /orgs/{org}/issue-types", { org: args.org });
      // Guard against a non-array response shape (transient API
      // hiccup, future API change, etc.). Surfacing this as a
      // structured error is far more useful than a confusing
      // "data.map is not a function" TypeError from below.
      if (!Array.isArray(response.data)) {
        throw new Error(
          `mcp-github: gh.org_issue_types_list: unexpected response shape from GET /orgs/${args.org}/issue-types — expected an array of issue types, got ${typeof response.data}`,
        );
      }
      const data = response.data as RawIssueType[];
      const out: Output = {
        types: data.map(summariseIssueType),
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.org_issue_types_list output",
      );
    },
  });
}
