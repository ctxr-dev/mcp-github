// src/tools/label/_shared.ts
//
// Helpers shared across the four gh.label_* tools. Mirrors the
// issue / pr domain shape: parse repo slug (re-exported from
// the issue domain), look up the repository node ID, summarise
// labels onto a stable JSON-Schema. The label-sync tool also
// uses repo-context to walk every existing label and compute a
// diff against the supplied YAML taxonomy.

import type { GraphqlClient } from "../../graphql/client.js";
import { parseRepoSlug as parseIssueRepoSlug, type RepoCoords, repoSlugSchema } from "../issue/_shared.js";

export type { RepoCoords };
export { repoSlugSchema };
export const parseRepoSlug = parseIssueRepoSlug;

// 6-character lowercase hex color, no leading `#`. GitHub stores
// the bare value (e.g. "d73a4a"), so we normalise on input.
export const colorSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{6}$",
  description:
    "6-character hex colour without a leading `#`, e.g. `d73a4a`.",
} as const;

export interface LabelSummary {
  name: string;
  color: string;
  description: string | null;
  url: string;
  node_id: string;
}

export const labelSummarySchema = {
  type: "object",
  required: ["name", "color", "description", "url", "node_id"],
  properties: {
    name: { type: "string" },
    color: { type: "string" },
    description: { type: ["string", "null"] },
    url: { type: "string" },
    node_id: { type: "string" },
  },
  additionalProperties: false,
} as const;

export interface RawLabel {
  id: string;
  name: string;
  color: string;
  description: string | null;
  url: string;
}

export function summariseLabel(raw: RawLabel): LabelSummary {
  return {
    name: raw.name,
    color: raw.color,
    description: raw.description,
    url: raw.url,
    node_id: raw.id,
  };
}

// Look up the repository's GraphQL node ID. Used by
// `gh.label_create` (CreateLabelInput requires `repositoryId`).
interface RepoIdResponse {
  repository: { id: string } | null;
}

export async function lookupRepoNodeId(
  graphql: GraphqlClient,
  coords: RepoCoords,
  where: string,
): Promise<string> {
  const data = await graphql<RepoIdResponse>("label/_repo-id", {
    owner: coords.owner,
    name: coords.name,
  });
  if (!data.repository) {
    throw new Error(
      `mcp-github: ${where}: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  return data.repository.id;
}

// Look up a single label's node ID by name. Used by
// `gh.label_edit` (UpdateLabelInput requires `id`) and the
// reconcile path of `gh.label_sync_from_yaml`.
interface LabelLookupResponse {
  repository: {
    label: RawLabel | null;
  } | null;
}

export async function lookupLabelByName(
  graphql: GraphqlClient,
  coords: RepoCoords,
  name: string,
  where: string,
): Promise<RawLabel> {
  const data = await graphql<LabelLookupResponse>("label/_lookup", {
    owner: coords.owner,
    name: coords.name,
    labelName: name,
  });
  if (!data.repository) {
    throw new Error(
      `mcp-github: ${where}: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  if (!data.repository.label) {
    throw new Error(
      `mcp-github: ${where}: label '${name}' not found in '${coords.owner}/${coords.name}'`,
    );
  }
  return data.repository.label;
}
