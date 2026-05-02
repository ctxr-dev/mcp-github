// tests/unit/tools/workflow/run_view.test.ts
//
// gh.workflow_run_view: pin the two-call REST flow (run + jobs),
// the job-summary shape, and the 404 → structured error
// translation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerWorkflowRunViewTool } from "../../../../src/tools/workflow/run_view.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import {
  httpError,
  sampleRawJob,
  sampleRawRun,
  stubAuthedRequest,
} from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.workflow_run_view") throw new Error(`unexpected: ${name}`);
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

test("gh.workflow_run_view: returns run + jobs summary in two REST calls", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}": sampleRawRun,
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
      total_count: 1,
      jobs: [sampleRawJob],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunViewTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    run_id: 5_000_000_001,
  })) as {
    run: { id: number; state: string };
    jobs: Array<{
      id: number;
      state: string;
      steps_completed: number;
      steps_total: number;
    }>;
    jobs_total: number;
    jobs_has_next_page: boolean;
  };
  assert.equal(out.run.id, 5_000_000_001);
  assert.equal(out.run.state, "success");
  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.id, 9_000_000_001);
  assert.equal(out.jobs[0]?.state, "success");
  assert.equal(out.jobs[0]?.steps_completed, 2);
  assert.equal(out.jobs[0]?.steps_total, 2);
  assert.equal(out.jobs_total, 1);
  assert.equal(out.jobs_has_next_page, false);
  assert.equal(calls.length, 2);
});

test("gh.workflow_run_view: jobs_has_next_page=true when total_count exceeds returned page", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}": sampleRawRun,
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
      // total_count > the single returned job → there is another page
      total_count: 137,
      jobs: [sampleRawJob],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunViewTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    run_id: 5_000_000_001,
  })) as { jobs_total: number; jobs_has_next_page: boolean };
  assert.equal(out.jobs_total, 137);
  assert.equal(out.jobs_has_next_page, true);
});

test("gh.workflow_run_view: 404 on run fetch translates to structured 'not found'", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}": () => {
      throw httpError(404, "Not Found");
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunViewTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", run_id: 12345 }),
    /run owner\/repo#12345 not found/,
  );
});

test("gh.workflow_run_view: failed job reports state: failure (conclusion-driven)", async () => {
  const failedJob = {
    ...sampleRawJob,
    conclusion: "failure",
  };
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}": sampleRawRun,
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
      total_count: 1,
      jobs: [failedJob],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunViewTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    run_id: 1,
  })) as { jobs: Array<{ state: string }> };
  assert.equal(out.jobs[0]?.state, "failure");
});
