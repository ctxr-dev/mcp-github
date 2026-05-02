// src/tools/workflow/run_cancel.ts
//
// `gh.workflow_run_cancel` — cancels an in-flight workflow run.
// REST `POST /repos/.../actions/runs/:id/cancel`. There is no
// GraphQL mutation for this — the spec acknowledges that
// "GraphQL coverage is incomplete" for Actions, and cancel is
// the canonical example of the gap.
//
// REST returns 202 (Accepted) on a successful cancel request;
// the cancellation is asynchronous, so the run's `state` won't
// flip to `cancelled` immediately. Output `cancelled: true`
// means "GitHub accepted the cancel request", not "the run is
// in the cancelled state right now".

import type { AuthedRequest } from "../../auth/octokit.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  getStatus,
  parseRepoSlug,
  repoSlugSchema,
  runIdSchema,
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

const outputSchema = {
  type: "object",
  required: ["cancelled", "run_id"],
  properties: {
    cancelled: {
      type: "boolean",
      description:
        "true means GitHub accepted the cancel request (HTTP 202). " +
        "Cancellation is asynchronous; poll `gh.workflow_run_view` " +
        "to observe the run transition into `cancelled` state.",
    },
    run_id: { type: "integer" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  run_id: number;
}

interface Output {
  cancelled: boolean;
  run_id: number;
}

export function registerWorkflowRunCancelTool(
  register: RegisterToolFn,
  authedRequest: AuthedRequest,
): void {
  register("gh.workflow_run_cancel", {
    description:
      "Cancel an in-flight Actions workflow run. POSTs to the REST " +
      "cancel endpoint (no GraphQL equivalent exists). Returns " +
      "`{cancelled: true, run_id}` on HTTP 202 — cancellation is " +
      "asynchronous, so poll `gh.workflow_run_view` to confirm.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.workflow_run_cancel input");
      const coords = parseRepoSlug(args.repo, "gh.workflow_run_cancel input");
      try {
        await authedRequest(
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
          { owner: coords.owner, repo: coords.name, run_id: args.run_id },
        );
      } catch (err) {
        const status = getStatus(err);
        if (status === 404) {
          throw new Error(
            `mcp-github: gh.workflow_run_cancel: run ${coords.owner}/${coords.name}#${args.run_id} not found`,
          );
        }
        if (status === 409) {
          // 409 Conflict: the run is already in a terminal state
          // (completed, cancelled, etc.) and cannot be cancelled.
          // Surface as a clean structured error rather than a
          // generic RequestError.
          throw new Error(
            `mcp-github: gh.workflow_run_cancel: run ${coords.owner}/${coords.name}#${args.run_id} is already in a terminal state and cannot be cancelled`,
          );
        }
        throw err;
      }
      const out: Output = { cancelled: true, run_id: args.run_id };
      return validate<Output>(outputSchema, out, "gh.workflow_run_cancel output");
    },
  });
}
