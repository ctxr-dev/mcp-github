// src/tools/org/_shared.ts
//
// Helpers shared across the gh.org_* tools. The org domain covers
// organisation-scoped operations that don't fit under issue / pr
// / label / project — at v0.1 that's just GitHub's native "Issue
// Types" (REST + GraphQL) used by the methodology's optional
// `label-taxonomy` flow to set canonical issue categories without
// piggybacking on labels.

// JSON-Schema-shaped summary of one Issue Type as returned by the
// REST endpoint `GET /orgs/{org}/issue-types`. The endpoint is
// not in `@octokit/openapi-types` yet, so we describe the wire
// format here and pin it via output validation. Fields pass
// through 1:1 from GitHub's response: `id` is numeric, `name`/
// `description`/`color` are strings (the latter two nullable),
// `is_enabled` is a non-nullable boolean, and the timestamps
// are ISO-8601 strings.
export interface IssueTypeSummary {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const issueTypeSummarySchema = {
  type: "object",
  required: [
    "id",
    "name",
    "description",
    "color",
    "is_enabled",
    "created_at",
    "updated_at",
  ],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    // GitHub returns the color as an unprefixed enum-ish string
    // (`gray`, `blue`, `green`, `yellow`, `orange`, `red`, `pink`,
    // `purple`) — leave it as a free string for forward
    // compatibility rather than pinning the enum.
    color: { type: ["string", "null"] },
    is_enabled: { type: "boolean" },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  },
  additionalProperties: false,
} as const;

export interface RawIssueType {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function summariseIssueType(raw: RawIssueType): IssueTypeSummary {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    color: raw.color,
    is_enabled: raw.is_enabled,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

// JSON-Schema fragment for the `org` input every gh.org_* tool
// requires. Inlined into each tool's schema rather than `$ref`'d
// to match the other domains' pattern.
export const orgLoginSchema = {
  type: "string",
  // GitHub login charset: alphanumeric and single hyphens, no
  // leading/trailing/double hyphens. Conservative pattern
  // matches the same form the API accepts.
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$",
  description: "Organisation login (e.g. `my-org`).",
} as const;
