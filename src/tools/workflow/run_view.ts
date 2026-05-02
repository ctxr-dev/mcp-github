// src/tools/workflow/run_view.ts
//
// `gh.workflow_run_view` — fetches a single workflow run plus a
// jobs summary. Two REST calls (one for the run, one for the
// jobs of the latest attempt). Output stays flat — the run
// summary at the top, an array of jobs alongside it.

import type { AuthedRequest } from "../../auth/octokit.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type RawRun,
  type RunState,
  type RunSummary,
  flattenRunState,
  getStatus,
  parseRepoSlug,
  repoSlugSchema,
  runIdSchema,
  runStateSchema,
  runSummarySchema,
  summariseRun,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "run_id"],
  properties: {
    repo: repoSlugSchema,
    run_id: runIdSchema,
  },
  additionalProperties: false,
} as const;

interface JobSummary {
  id: number;
  name: string;
  state: RunState;
  started_at: string | null;
  completed_at: string | null;
  url: string;
  steps_completed: number;
  steps_total: number;
}

const jobSummarySchema = {
  type: "object",
  required: [
    "id",
    "name",
    "state",
    "started_at",
    "completed_at",
    "url",
    "steps_completed",
    "steps_total",
  ],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    state: runStateSchema,
    started_at: { type: ["string", "null"] },
    completed_at: { type: ["string", "null"] },
    url: { type: "string" },
    steps_completed: { type: "integer", minimum: 0 },
    steps_total: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["run", "jobs", "jobs_total", "jobs_has_next_page"],
  properties: {
    run: runSummarySchema,
    jobs: { type: "array", items: jobSummarySchema },
    jobs_total: {
      type: "integer",
      minimum: 0,
      description: "Total jobs across all pages (`total_count` from the API).",
    },
    jobs_has_next_page: {
      type: "boolean",
      description:
        "true when the run has more jobs than this single page returned " +
        "(jobs are capped at 100 per page). Use `gh.workflow_run_jobs` to " +
        "paginate through the rest.",
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  run_id: number;
}

interface Output {
  run: RunSummary;
  jobs: JobSummary[];
  jobs_total: number;
  jobs_has_next_page: boolean;
}

interface RawJobStep {
  status?: string | null;
  conclusion?: string | null;
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
  steps?: RawJobStep[];
}

interface JobsResponse {
  total_count: number;
  jobs: RawJob[];
}

export function registerWorkflowRunViewTool(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  register("gh.workflow_run_view", {
    description:
      "Fetch a single Actions workflow run plus a summary of its " +
      "jobs (id, state, timestamps, step counts). Two REST calls " +
      "under the hood: GET .../runs/:id and GET .../runs/:id/jobs. " +
      "Jobs are capped at 100 per page; check `jobs_has_next_page` " +
      "and use `gh.workflow_run_jobs` to paginate the remainder.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.workflow_run_view input");
      const coords = parseRepoSlug(args.repo, "gh.workflow_run_view input");
      let runResp;
      try {
        runResp = await authedRequest(
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
          { owner: coords.owner, repo: coords.name, run_id: args.run_id },
        );
      } catch (err) {
        // Translate 404 into a structured "not found" so the
        // caller distinguishes it from a transport-level
        // failure.
        if (getStatus(err) === 404) {
          throw new Error(
            `mcp-github: gh.workflow_run_view: run ${coords.owner}/${coords.name}#${args.run_id} not found`,
          );
        }
        throw err;
      }
      const jobsResp = await authedRequest(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
        { owner: coords.owner, repo: coords.name, run_id: args.run_id, per_page: 100 },
      );
      const jobsData = jobsResp.data as JobsResponse;
      const jobs = (jobsData.jobs ?? []).map(summariseJob);
      const out: Output = {
        run: summariseRun(runResp.data as RawRun),
        jobs,
        jobs_total: jobsData.total_count,
        jobs_has_next_page: jobsData.total_count > jobs.length,
      };
      return validate<Output>(outputSchema, out, "gh.workflow_run_view output");
    },
  });
}

function summariseJob(raw: RawJob): JobSummary {
  const steps = raw.steps ?? [];
  const completed = steps.filter((s) => s.status === "completed").length;
  return {
    id: raw.id,
    name: raw.name,
    state: flattenRunState(raw.status, raw.conclusion),
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    url: raw.html_url ?? raw.url ?? "",
    steps_completed: completed,
    steps_total: steps.length,
  };
}
