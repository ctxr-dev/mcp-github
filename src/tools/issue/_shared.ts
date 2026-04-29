// src/tools/issue/_shared.ts
//
// Helpers shared across the seven `gh.issue_*` tools. Lives here
// (rather than in registry.ts or under src/) because everything in
// this file is specific to the issue domain.
//
// The MCP-4 surface accepts repo as `"owner/name"` (matching `gh`
// CLI ergonomics) plus labels/assignees as login-strings, and runs
// the name-to-ID resolution against the GraphQL API. Centralising
// the parsers + resolvers here keeps the tool files focused on
// their specific operation rather than re-implementing the same
// lookups seven times.

import type { GraphqlClient } from "../../graphql/client.js";

// Format used everywhere: `"owner/name"`. Spaces are rejected so a
// caller mis-passing `" owner/name"` doesn't silently produce a
// "repository not found" error from GitHub later.
const REPO_SLUG_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export interface RepoCoords {
  owner: string;
  name: string;
}

export function parseRepoSlug(slug: string, where: string): RepoCoords {
  const match = REPO_SLUG_RE.exec(slug);
  if (!match) {
    throw new Error(
      `mcp-github: ${where}: invalid repo '${slug}', expected "owner/name"`,
    );
  }
  return { owner: match[1] as string, name: match[2] as string };
}

// Result of `_repo-context`: the repository's GraphQL node ID plus
// the first page of its labels and assignable users. Used by
// `gh.issue_create` and `gh.issue_edit` to resolve label names /
// assignee logins to the GraphQL IDs that mutations require.
export interface RepoContext {
  repositoryId: string;
  labelsByName: Map<string, string>;
  usersByLogin: Map<string, string>;
}

interface RepoContextResponse {
  repository: {
    id: string;
    labels: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{ id: string; name: string }>;
    };
    assignableUsers: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{ id: string; login: string }>;
    };
  } | null;
}

export async function loadRepoContext(
  graphql: GraphqlClient,
  coords: RepoCoords,
): Promise<RepoContext> {
  const data = await graphql<RepoContextResponse>("issue/_repo-context", {
    owner: coords.owner,
    name: coords.name,
  });
  if (!data.repository) {
    throw new Error(
      `mcp-github: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  // Detect truncation. With `first: 100` on each connection, a
  // repo with more than 100 labels or assignable users would
  // silently produce false "unknown label" / "unknown login"
  // errors for valid inputs that happened to live on page 2+. v0.1
  // doesn't paginate; we throw a clear, actionable error instead
  // so the caller sees the real cause and can pre-resolve IDs
  // externally until full pagination lands in a later PR.
  if (data.repository.labels.pageInfo.hasNextPage) {
    throw new Error(
      `mcp-github: repository '${coords.owner}/${coords.name}' has more than 100 labels; ` +
        `name-based resolution is not supported on this repo at v0.1. Use label IDs directly or paginate externally.`,
    );
  }
  if (data.repository.assignableUsers.pageInfo.hasNextPage) {
    throw new Error(
      `mcp-github: repository '${coords.owner}/${coords.name}' has more than 100 assignable users; ` +
        `login-based resolution is not supported on this repo at v0.1. Use user IDs directly or paginate externally.`,
    );
  }
  // Build name→id maps once so the per-label / per-assignee resolve
  // is O(1).
  const labelsByName = new Map<string, string>();
  for (const node of data.repository.labels.nodes) {
    labelsByName.set(node.name, node.id);
  }
  const usersByLogin = new Map<string, string>();
  for (const node of data.repository.assignableUsers.nodes) {
    usersByLogin.set(node.login, node.id);
  }
  return {
    repositoryId: data.repository.id,
    labelsByName,
    usersByLogin,
  };
}

export function resolveLabelIds(
  context: RepoContext,
  names: readonly string[],
  where: string,
): string[] {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const id = context.labelsByName.get(name);
    if (id === undefined) {
      missing.push(name);
    } else {
      ids.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `mcp-github: ${where}: unknown label(s): ${missing.join(", ")}`,
    );
  }
  return ids;
}

export function resolveAssigneeIds(
  context: RepoContext,
  logins: readonly string[],
  where: string,
): string[] {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const login of logins) {
    const id = context.usersByLogin.get(login);
    if (id === undefined) {
      missing.push(login);
    } else {
      ids.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `mcp-github: ${where}: unknown / non-assignable login(s): ${missing.join(", ")}`,
    );
  }
  return ids;
}

// Looks up an issue's GraphQL node ID by repo + number. Used by the
// three mutations that operate on an existing issue (edit, close,
// comment) and don't otherwise need the full repo context.
interface IssueLookupResponse {
  repository: {
    issue: { id: string } | null;
  } | null;
}

export async function lookupIssueNodeId(
  graphql: GraphqlClient,
  coords: RepoCoords,
  number: number,
  where: string,
): Promise<string> {
  const data = await graphql<IssueLookupResponse>("issue/_issue-lookup", {
    owner: coords.owner,
    name: coords.name,
    number,
  });
  // Distinguish "repo missing / no access" from "issue missing".
  // Collapsing the two confused operators staring at typos in the
  // repo slug — they'd see "issue X not found" and start hunting
  // for the issue when the real problem was the repo.
  if (!data.repository) {
    throw new Error(
      `mcp-github: ${where}: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  const issueId = data.repository.issue?.id;
  if (typeof issueId !== "string") {
    throw new Error(
      `mcp-github: ${where}: issue ${coords.owner}/${coords.name}#${number} not found`,
    );
  }
  return issueId;
}

// Common JSON-Schema fragment for `repo` (used by every input
// schema in this domain). Inlined into each tool's schema rather
// than `$ref`'d because ajv's strict-false config doesn't load
// external schemas implicitly and the savings of ~5 lines per file
// is not worth the indirection.
export const repoSlugSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$",
  description: "Repository in the form `owner/name`",
} as const;

// Shape we return from view/edit/close handlers. Matches the
// `Issue` GraphQL type's most useful fields; tools can omit
// nullable fields when constructing this from their response.
export interface IssueSummary {
  number: number;
  url: string;
  node_id: string;
  title: string;
  state: "OPEN" | "CLOSED";
  body: string | null;
  labels: string[];
  assignees: string[];
  author: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export const issueSummarySchema = {
  type: "object",
  required: [
    "number",
    "url",
    "node_id",
    "title",
    "state",
    "body",
    "labels",
    "assignees",
    "author",
    "created_at",
    "updated_at",
    "closed_at",
  ],
  properties: {
    number: { type: "integer" },
    url: { type: "string" },
    node_id: { type: "string" },
    title: { type: "string" },
    state: { type: "string", enum: ["OPEN", "CLOSED"] },
    body: { type: ["string", "null"] },
    labels: { type: "array", items: { type: "string" } },
    assignees: { type: "array", items: { type: "string" } },
    author: { type: ["string", "null"] },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    closed_at: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

// Shape returned by GraphQL for an Issue: a superset of what we
// expose. Tools use this to type the response, then map to
// `IssueSummary` before validating.
export interface RawIssue {
  number: number;
  url: string;
  id: string;
  title: string;
  state: "OPEN" | "CLOSED";
  body: string | null;
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export function summariseIssue(raw: RawIssue): IssueSummary {
  return {
    number: raw.number,
    url: raw.url,
    node_id: raw.id,
    title: raw.title,
    state: raw.state,
    body: raw.body,
    labels: raw.labels.nodes.map((n) => n.name),
    assignees: raw.assignees.nodes.map((n) => n.login),
    author: raw.author?.login ?? null,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
    closed_at: raw.closedAt,
  };
}
