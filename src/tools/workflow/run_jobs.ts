// src/tools/workflow/run_jobs.ts
//
// `gh.workflow_run_jobs` — lists jobs for a workflow run with
// step-level details. Differs from `run_view` by surfacing the
// per-step status / conclusion / timestamps so callers can see
// where in a run a failure happened.
//
// `attempt_number` defaults to the latest attempt; pass a
// specific value to read a re-run's jobs.

import type { AuthedRequest } from "../../auth/octokit.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type RunState,
  flattenRunState,
  getStatus,
  parseRepoSlug,
  repoSlugSchema,
  runIdSchema,
  runStateSchema,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "run_id"],
  properties: {
    repo: repoSlugSchema,
    run_id: runIdSchema,
    attempt_number: {
      type: "integer",
      minimum: 1,
      description:
        "Attempt number to read jobs for. Omit for the latest attempt.",
    },
  },
  additionalProperties: false,
} as const;

interface StepDetail {
  name: string;
  number: number;
  state: RunState;
  started_at: string | null;
  completed_at: string | null;
}

const stepDetailSchema = {
  type: "object",
  required: ["name", "number", "state", "started_at", "completed_at"],
  properties: {
    name: { type: "string" },
    number: { type: "integer", minimum: 1 },
    state: runStateSchema,
    started_at: { type: ["string", "null"] },
    completed_at: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

interface JobDetail {
  id: number;
  name: string;
  state: RunState;
  started_at: string | null;
  completed_at: string | null;
  url: string;
  attempt: number;
  steps: StepDetail[];
}

const jobDetailSchema = {
  type: "object",
  required: [
    "id",
    "name",
    "state",
    "started_at",
    "completed_at",
    "url",
    "attempt",
    "steps",
  ],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    state: runStateSchema,
    started_at: { type: ["string", "null"] },
    completed_at: { type: ["string", "null"] },
    url: { type: "string" },
    attempt: { type: "integer", minimum: 1 },
    steps: { type: "array", items: stepDetailSchema },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "total"],
  properties: {
    items: { type: "array", items: jobDetailSchema },
    total: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  run_id: number;
  attempt_number?: number;
}

interface Output {
  items: JobDetail[];
  total: number;
}

interface RawStep {
  name: string;
  number: number;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface RawJob {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url?: string;
  url?: string;
  run_attempt?: number;
  steps?: RawStep[];
}

interface JobsResponse {
  total_count: number;
  jobs: RawJob[];
}

export function registerWorkflowRunJobsTool(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  register("gh.workflow_run_jobs", {
    description:
      "List jobs for a workflow run with step-level details. Use " +
      "`attempt_number` to read jobs for a specific attempt; omit " +
      "for the latest. Caps at 100 jobs (the REST endpoint's max).",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.workflow_run_jobs input");
      const coords = parseRepoSlug(args.repo, "gh.workflow_run_jobs input");
      const params: Record<string, string | number> = {
        owner: coords.owner,
        repo: coords.name,
        run_id: args.run_id,
        per_page: 100,
      };
      // The REST endpoint distinguishes between
      //   GET .../runs/:id/jobs            → latest attempt
      //   GET .../runs/:id/attempts/:n/jobs → specific attempt
      // (`attempt_number` as a query param on the first URL was
      // never honoured; use the dedicated route instead).
      const url =
        args.attempt_number === undefined
          ? "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs"
          : "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs";
      if (args.attempt_number !== undefined) {
        params["attempt_number"] = args.attempt_number;
      }
      let response;
      try {
        // Same cast pattern as runs_list: Octokit's request
        // narrows on the route string and our params object is
        // too dynamic for that narrowing.
        response = await authedRequest(
          url,
          params as unknown as { owner: string; repo: string; run_id: number },
        );
      } catch (err) {
        if (getStatus(err) === 404) {
          throw new Error(
            `mcp-github: gh.workflow_run_jobs: run ${coords.owner}/${coords.name}#${args.run_id}` +
              `${args.attempt_number !== undefined ? ` attempt ${args.attempt_number}` : ""}` +
              ` not found`,
          );
        }
        throw err;
      }
      const data = response.data as JobsResponse;
      const out: Output = {
        items: (data.jobs ?? []).map(buildJobDetail),
        total: data.total_count,
      };
      return validate<Output>(outputSchema, out, "gh.workflow_run_jobs output");
    },
  });
}

function buildJobDetail(raw: RawJob): JobDetail {
  return {
    id: raw.id,
    name: raw.name,
    state: flattenRunState(raw.status, raw.conclusion),
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    url: raw.html_url ?? raw.url ?? "",
    attempt: raw.run_attempt ?? 1,
    steps: (raw.steps ?? []).map((s) => ({
      name: s.name,
      number: s.number,
      state: flattenRunState(s.status, s.conclusion),
      started_at: s.started_at ?? null,
      completed_at: s.completed_at ?? null,
    })),
  };
}
