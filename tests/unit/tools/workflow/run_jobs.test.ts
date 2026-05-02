// tests/unit/tools/workflow/run_jobs.test.ts
//
// gh.workflow_run_jobs: pin the per-attempt route switching, the
// step-level detail, and the 404 → structured error.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerWorkflowRunJobsTool } from "../../../../src/tools/workflow/run_jobs.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import {
  httpError,
  sampleRawJob,
  stubAuthedRequest,
} from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.workflow_run_jobs") throw new Error(`unexpected: ${name}`);
    entry = e;
  };
  return {
    register,
    get entry(): ToolEntry {
      if (!entry) throw new Error("not registered");
      return entry;
    },
  };
}

test("gh.workflow_run_jobs: omitting attempt_number hits the latest-attempt route", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
      total_count: 1,
      jobs: [sampleRawJob],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunJobsTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    run_id: 5_000_000_001,
  })) as {
    items: Array<{ id: number; steps: Array<{ name: string; state: string }> }>;
    total: number;
    hasNextPage: boolean;
    page: number;
  };
  assert.equal(out.total, 1);
  assert.equal(out.items[0]?.id, 9_000_000_001);
  assert.equal(out.items[0]?.steps.length, 2);
  assert.equal(out.items[0]?.steps[0]?.name, "Set up job");
  assert.equal(out.items[0]?.steps[0]?.state, "success");
  assert.equal(out.hasNextPage, false);
  assert.equal(out.page, 1);
  assert.equal(calls[0]?.route, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs");
});

test("gh.workflow_run_jobs: page/perPage forwarded; hasNextPage true when more results exist", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
      total_count: 250,
      jobs: [sampleRawJob],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunJobsTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    run_id: 5_000_000_001,
    page: 2,
    perPage: 50,
  })) as { total: number; hasNextPage: boolean; page: number };
  assert.equal(calls[0]?.params.page, 2);
  assert.equal(calls[0]?.params.per_page, 50);
  assert.equal(out.total, 250);
  // page 2 of 50 = 100 < 250, so there is more
  assert.equal(out.hasNextPage, true);
  assert.equal(out.page, 2);
});

test("gh.workflow_run_jobs: attempt_number switches to the dedicated attempts route", async () => {
  // The REST API has TWO endpoints here. The query-param form
  // on the latest-attempt route doesn't honour `attempt_number`;
  // a specific attempt requires the dedicated path. Pin which
  // route gets called.
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs": {
      total_count: 1,
      jobs: [sampleRawJob],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunJobsTool(reg.register, authedRequest);
  await reg.entry.handler({
    repo: "owner/repo",
    run_id: 5_000_000_001,
    attempt_number: 2,
  });
  assert.equal(
    calls[0]?.route,
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
  );
  assert.equal(calls[0]?.params.attempt_number, 2);
});

test("gh.workflow_run_jobs: failed step in a job surfaces state: failure on the step", async () => {
  const failedStep = {
    ...sampleRawJob,
    steps: [
      {
        ...sampleRawJob.steps[0],
        status: "completed",
        conclusion: "failure",
      },
    ],
  };
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
      total_count: 1,
      jobs: [failedStep],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunJobsTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    run_id: 1,
  })) as { items: Array<{ steps: Array<{ state: string }> }> };
  assert.equal(out.items[0]?.steps[0]?.state, "failure");
});

test("gh.workflow_run_jobs: 404 → structured 'run/attempt not found'", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs": () => {
      throw httpError(404);
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunJobsTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      run_id: 99,
      attempt_number: 7,
    }),
    /run owner\/repo#99 attempt 7 not found/,
  );
});
