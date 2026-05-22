// src/tools/project/_shared.ts
//
// Helpers shared across the four gh.project_* tools. Two
// resolvers live here: project-id lookup from `(owner, number)`
// and content-id lookup from a GitHub issue/PR URL — both are
// pre-mutation steps that any tool taking a "project" or
// "content item" reference might need.

import type { GraphqlClient } from "../../graphql/client.js";

// Project v2 lives under Organization.projectV2(number) OR
// User.projectV2(number). We try both in a single query and
// take whichever returns non-null.
interface ProjectIdResponse {
  organization: { projectV2: { id: string } | null } | null;
  user: { projectV2: { id: string } | null } | null;
}

export async function lookupProjectIdByOwnerNumber(
  graphql: GraphqlClient,
  owner: string,
  number: number,
  where: string,
): Promise<string> {
  const data = await graphql<ProjectIdResponse>(
    "project/_resolve-project-id",
    { owner, number },
  );
  const id =
    data.organization?.projectV2?.id ?? data.user?.projectV2?.id ?? null;
  if (id === null) {
    throw new Error(
      `mcp-github: ${where}: project '${owner}/projects/${number}' not found (or token lacks read access; project v2 needs the 'project' scope on a classic PAT, or 'Projects: Read' on a fine-grained token)`,
    );
  }
  return id;
}

// JSON-Schema fragment that demands EITHER `project_id` (raw
// GraphQL node ID) OR `(owner, number)`. Reused across every
// project tool that takes a project reference.
export const projectRefSchemaProps = {
  project_id: {
    type: "string",
    minLength: 1,
    description:
      "Project v2 GraphQL node ID. Mutually exclusive with " +
      "owner + number; supply ONE of the two.",
  },
  owner: {
    type: "string",
    minLength: 1,
    description:
      "Project owner login (org or user). Pair with `number`. " +
      "Mutually exclusive with project_id.",
  },
  number: {
    type: "integer",
    minimum: 1,
    description: "Project number. Pair with `owner`.",
  },
} as const;

// `oneOf` block to pin the project-reference contract: either
// `project_id` alone, or `owner + number` together. Mixed shapes
// (e.g. project_id + owner) are rejected at the schema boundary.
export const projectRefOneOf = [
  {
    required: ["project_id"],
    not: { anyOf: [{ required: ["owner"] }, { required: ["number"] }] },
  },
  {
    required: ["owner", "number"],
    not: { required: ["project_id"] },
  },
] as const;

// Resolve a project reference (one of the two shapes above) to
// a GraphQL node ID. Tools call this once at the top of their
// handler so the body can assume `projectId: string`.
export async function resolveProjectId(
  graphql: GraphqlClient,
  args: { project_id?: string; owner?: string; number?: number },
  where: string,
): Promise<string> {
  if (typeof args.project_id === "string") {
    return args.project_id;
  }
  if (typeof args.owner === "string" && typeof args.number === "number") {
    return lookupProjectIdByOwnerNumber(graphql, args.owner, args.number, where);
  }
  // Should be unreachable because the schema's `oneOf` enforces
  // one of the two shapes — defensive throw in case the schema
  // ever drifts.
  throw new Error(
    `mcp-github: ${where}: must supply either project_id or owner + number`,
  );
}

// Parse a GitHub issue/PR URL into the components needed to
// look up its GraphQL node ID. Returns null on no match (the
// caller surfaces a structured error).
export interface ContentRef {
  owner: string;
  name: string;
  number: number;
  type: "issue" | "pullRequest";
}

// Anchor after the numeric segment so `/issues/123abc` doesn't
// parse as `123` and silently resolve the wrong content. Allow
// end-of-string OR a real URL boundary character (`/`, `?`, `#`)
// so the common `/issues/123#issuecomment-1` and
// `/issues/123?foo=bar` shapes still match.
const URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:[/?#]|$)/;

export function parseContentUrl(url: string): ContentRef | null {
  const m = URL_RE.exec(url);
  if (!m) return null;
  const [, owner = "", name = "", typeSegment = "", numberStr = ""] = m;
  const number = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(number) || number < 1) return null;
  return {
    owner,
    name,
    number,
    type: typeSegment === "pull" ? "pullRequest" : "issue",
  };
}

interface ContentIdResponse {
  repository: {
    issue: { id: string } | null;
    pullRequest: { id: string } | null;
  } | null;
}

export async function lookupContentIdByUrl(
  graphql: GraphqlClient,
  url: string,
  where: string,
): Promise<string> {
  const ref = parseContentUrl(url);
  if (!ref) {
    throw new Error(
      `mcp-github: ${where}: content_url '${url}' is not a recognised github.com issue or pull URL`,
    );
  }
  const data = await graphql<ContentIdResponse>(
    "project/_resolve-content-id",
    { owner: ref.owner, name: ref.name, number: ref.number },
  );
  if (!data.repository) {
    throw new Error(
      `mcp-github: ${where}: repository '${ref.owner}/${ref.name}' (from content_url) not found or token lacks read access`,
    );
  }
  const id =
    ref.type === "issue"
      ? data.repository.issue?.id
      : data.repository.pullRequest?.id;
  if (typeof id !== "string") {
    throw new Error(
      `mcp-github: ${where}: ${ref.type} ${ref.owner}/${ref.name}#${ref.number} (from content_url) not found`,
    );
  }
  return id;
}

// Project v2 field types we surface. Both user-defined types
// (TEXT / NUMBER / DATE / SINGLE_SELECT / ITERATION) and the
// derived ones (ASSIGNEES, LABELS, MILESTONE, REPOSITORY, TITLE,
// REVIEWERS, TRACKED_BY, TRACKS, LINKED_PULL_REQUESTS,
// PARENT_ISSUE, SUB_ISSUES_PROGRESS) are returned by
// `gh.project_field_list` and `gh.project_items_list`. The
// derived ones are read-only projections of the underlying
// issue/PR; they cannot be set via `gh.project_item_update_field`,
// which only accepts the five user-defined types.
export type ProjectFieldType =
  | "TEXT"
  | "NUMBER"
  | "DATE"
  | "SINGLE_SELECT"
  | "ITERATION"
  | "ASSIGNEES"
  | "LABELS"
  | "MILESTONE"
  | "REPOSITORY"
  | "TITLE"
  | "REVIEWERS"
  | "TRACKED_BY"
  | "TRACKS"
  | "LINKED_PULL_REQUESTS"
  | "PARENT_ISSUE"
  | "SUB_ISSUES_PROGRESS";

export const projectFieldTypeSchema = {
  type: "string",
  enum: [
    "TEXT",
    "NUMBER",
    "DATE",
    "SINGLE_SELECT",
    "ITERATION",
    "ASSIGNEES",
    "LABELS",
    "MILESTONE",
    "REPOSITORY",
    "TITLE",
    "REVIEWERS",
    "TRACKED_BY",
    "TRACKS",
    "LINKED_PULL_REQUESTS",
    "PARENT_ISSUE",
    "SUB_ISSUES_PROGRESS",
  ],
} as const;

export interface ProjectFieldOption {
  id: string;
  name: string;
}

export const projectFieldOptionSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
  },
  additionalProperties: false,
} as const;

export interface ProjectFieldSummary {
  id: string;
  name: string;
  data_type: ProjectFieldType;
  options: ProjectFieldOption[];
}

export const projectFieldSummarySchema = {
  type: "object",
  required: ["id", "name", "data_type", "options"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    data_type: projectFieldTypeSchema,
    // `options` is non-empty only for SINGLE_SELECT and
    // ITERATION fields. Always present (empty array elsewhere)
    // so the shape is uniform.
    options: { type: "array", items: projectFieldOptionSchema },
  },
  additionalProperties: false,
} as const;
