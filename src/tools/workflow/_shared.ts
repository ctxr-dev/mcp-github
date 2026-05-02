// src/tools/workflow/_shared.ts
//
// Helpers shared across the four gh.workflow_* tools. Unlike the
// issue/pr/label domains, these tools call REST under the hood:
// GitHub's GraphQL coverage of Actions is incomplete — there is
// no `cancelWorkflowRun` mutation, the run-list filters are
// weaker than REST's, and the job-step detail surface barely
// exists in GraphQL. Falling back to REST via the authed
// `@octokit/request` client (the same one `gh.test_connection`
// uses) keeps the surface complete.
//
// We still re-export `parseRepoSlug` and `repoSlugSchema` from
// the issue domain so the shape rule for `repo` is identical
// across every tool category.

import type { RequestError } from "@octokit/request-error";

import { parseRepoSlug as parseIssueRepoSlug, type RepoCoords, repoSlugSchema } from "../issue/_shared.js";

export type { RepoCoords };
export { repoSlugSchema };
export const parseRepoSlug = parseIssueRepoSlug;

// Canonical CI status enum used across this domain. Mirrors the
// `status` × `conclusion` combination GitHub returns for Actions
// runs: a run is `queued | in_progress | completed`, and a
// completed run carries one of the conclusions below. We
// flatten the two into a single `state` string for ergonomics —
// callers care about "is it done? did it pass?" more than they
// care about the status/conclusion split.
export type RunState =
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral";

export const runStateSchema = {
  type: "string",
  enum: [
    "queued",
    "in_progress",
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
  ],
} as const;

// REST returns `status` and `conclusion` separately. Collapse
// them into the canonical `RunState` so consumers don't have to
// branch on both. An in-flight run has `conclusion: null`; a
// completed run's conclusion is the meaningful field.
export function flattenRunState(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): RunState {
  if (status === "queued") return "queued";
  if (status === "in_progress" || status === "waiting" || status === "pending" || status === "requested")
    return "in_progress";
  // status === "completed" — fall through to conclusion
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "timed_out":
      return "timed_out";
    case "action_required":
      return "action_required";
    case "neutral":
      return "neutral";
    default:
      // Unknown / null conclusion on a completed run is rare but
      // possible (very old runs in archived repos); treat as
      // neutral so the type stays inhabited.
      return "neutral";
  }
}

// Canonical run summary shape. Returned by both runs_list (per
// item) and run_view.
export interface RunSummary {
  id: number;
  url: string;
  name: string;
  workflow_name: string | null;
  branch: string | null;
  state: RunState;
  event: string;
  run_attempt: number;
  head_sha: string;
  actor: string | null;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
}

export const runSummarySchema = {
  type: "object",
  required: [
    "id",
    "url",
    "name",
    "workflow_name",
    "branch",
    "state",
    "event",
    "run_attempt",
    "head_sha",
    "actor",
    "created_at",
    "updated_at",
    "run_started_at",
  ],
  properties: {
    id: { type: "integer" },
    url: { type: "string" },
    name: { type: "string" },
    workflow_name: { type: ["string", "null"] },
    branch: { type: ["string", "null"] },
    state: runStateSchema,
    event: { type: "string" },
    run_attempt: { type: "integer", minimum: 1 },
    head_sha: { type: "string" },
    actor: { type: ["string", "null"] },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    run_started_at: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

// Raw shape REST returns under `runs[]` (or for a single run).
// Only the fields we project onto `RunSummary` are typed.
export interface RawRun {
  id: number;
  html_url?: string;
  url?: string;
  name?: string | null;
  display_title?: string | null;
  workflow_name?: string | null;
  head_branch?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string;
  run_attempt?: number;
  head_sha?: string;
  actor?: { login: string } | null;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string | null;
}

export function summariseRun(raw: RawRun): RunSummary {
  return {
    id: raw.id,
    // Prefer the HTML URL (browser-clickable); fall back to the
    // API URL if html_url is missing (it shouldn't be, but the
    // type lets it).
    url: raw.html_url ?? raw.url ?? "",
    name: raw.display_title ?? raw.name ?? "",
    workflow_name: raw.workflow_name ?? null,
    branch: raw.head_branch ?? null,
    state: flattenRunState(raw.status, raw.conclusion),
    event: raw.event ?? "",
    run_attempt: raw.run_attempt ?? 1,
    head_sha: raw.head_sha ?? "",
    actor: raw.actor?.login ?? null,
    created_at: raw.created_at ?? "",
    updated_at: raw.updated_at ?? "",
    run_started_at: raw.run_started_at ?? null,
  };
}

// JSON-Schema fragment for run-id integers, reused across all
// three tools that take one.
export const runIdSchema = { type: "integer", minimum: 1 } as const;

// Helper: read an HTTP status code off a thrown REST error
// without dragging the full `@octokit/request-error` import
// into every tool file.
export function getStatus(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as RequestError).status === "number"
  ) {
    return (err as RequestError).status;
  }
  return undefined;
}
