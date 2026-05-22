// src/tools/workflow/runs_list.ts
//
// `gh.workflow_runs_list` — paginated list of Actions workflow
// runs in a repo, optionally filtered by branch / status. Calls
// REST `GET /repos/:o/:r/actions/runs` because GraphQL's filter
// surface for runs is too narrow (no branch/status filter on
// `Repository.workflows.runs`). Output flattens the REST
// status/conclusion pair onto the canonical `RunState` enum so
// consumers don't have to branch on both fields.

import type { AuthedRequest } from "../../auth/octokit.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type RawRun,
  type RunSummary,
  parseRepoSlug,
  repoSlugSchema,
  runSummarySchema,
  summariseRun,
} from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

const inputSchema = {
  type: "object",
  required: ["repo"],
  properties: {
    repo: repoSlugSchema,
    branch: {
      type: "string",
      minLength: 1,
      description: "Filter to runs whose head branch matches.",
    },
    status: {
      // The REST `status` query parameter accepts BOTH the raw
      // `status` (queued | in_progress | completed) AND specific
      // `conclusion` shorthand values (success | failure | etc.)
      // — passing one filters the underlying list. Mirror the
      // canonical `RunState` so callers don't have to know the
      // distinction.
      type: "string",
      enum: [
        "queued",
        "in_progress",
        "completed",
        "success",
        "failure",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "neutral",
      ],
    },
    perPage: { type: "integer", minimum: 1, maximum: PER_PAGE_MAX },
    page: {
      type: "integer",
      minimum: 1,
      description:
        "1-indexed page number. REST workflow-runs uses page-based " +
        "pagination, not opaque cursors.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "total", "hasNextPage", "page"],
  properties: {
    items: { type: "array", items: runSummarySchema },
    total: {
      type: "integer",
      description: "Total runs across all pages (`total_count` from the API).",
    },
    hasNextPage: { type: "boolean" },
    page: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  branch?: string;
  status?: string;
  perPage?: number;
  page?: number;
}

interface Output {
  items: RunSummary[];
  total: number;
  hasNextPage: boolean;
  page: number;
}

interface Response {
  total_count: number;
  workflow_runs: RawRun[];
}

export function registerWorkflowRunsListTool(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  register("gh.workflow_runs_list", {
    description:
      "List Actions workflow runs in a repo, optionally filtered " +
      "by branch / status. `status` accepts both the raw status " +
      "(queued|in_progress|completed) and a conclusion " +
      "(success|failure|cancelled|skipped|timed_out|action_required|" +
      "neutral). Returns one page; advance via `page`.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.workflow_runs_list input");
      const coords = parseRepoSlug(args.repo, "gh.workflow_runs_list input");
      const params: Record<string, string | number> = {
        owner: coords.owner,
        repo: coords.name,
        per_page: args.perPage ?? PER_PAGE_DEFAULT,
        page: args.page ?? 1,
      };
      if (args.branch !== undefined) params["branch"] = args.branch;
      if (args.status !== undefined) params["status"] = args.status;
      // Cast through `unknown` because Octokit's request type
      // narrows by route string and our incrementally-built
      // params object is too dynamic for that narrowing — every
      // value is a valid GET-query primitive at runtime, so the
      // cast is sound.
      const response = await authedRequest(
        "GET /repos/{owner}/{repo}/actions/runs",
        params as unknown as { owner: string; repo: string },
      );
      const data = response.data as Response;
      const out: Output = {
        items: data.workflow_runs.map(summariseRun),
        total: data.total_count,
        // REST returns Link headers for next/prev; computing
        // hasNextPage from `total_count` and the current page +
        // per_page is simpler and avoids parsing the header.
        hasNextPage:
          (params["page"] as number) * (params["per_page"] as number) <
          data.total_count,
        page: params["page"] as number,
      };
      return validate<Output>(outputSchema, out, "gh.workflow_runs_list output");
    },
  });
}
