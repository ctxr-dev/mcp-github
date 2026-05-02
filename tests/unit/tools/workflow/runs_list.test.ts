// tests/unit/tools/workflow/runs_list.test.ts
//
// gh.workflow_runs_list: pin the REST query-param shape, the
// status/conclusion → state flattening, and the page-based
// hasNextPage computation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerWorkflowRunsListTool } from "../../../../src/tools/workflow/runs_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawRun, stubAuthedRequest } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.workflow_runs_list") throw new Error(`unexpected: ${name}`);
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

test("gh.workflow_runs_list: maps REST response onto canonical RunSummary", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs": {
      total_count: 1,
      workflow_runs: [sampleRawRun],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunsListTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({ repo: "owner/repo" })) as {
    items: Array<{ id: number; state: string; branch: string | null }>;
    total: number;
    hasNextPage: boolean;
    page: number;
  };
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.id, 5_000_000_001);
  assert.equal(out.items[0]?.state, "success");
  assert.equal(out.items[0]?.branch, "feat/x");
  assert.equal(out.total, 1);
  assert.equal(out.hasNextPage, false);
  assert.equal(out.page, 1);
  assert.equal(calls[0]?.params.owner, "owner");
  assert.equal(calls[0]?.params.repo, "repo");
});

test("gh.workflow_runs_list: branch + status filters pass through to query params", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs": {
      total_count: 0,
      workflow_runs: [],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunsListTool(reg.register, authedRequest);
  await reg.entry.handler({
    repo: "owner/repo",
    branch: "main",
    status: "failure",
    perPage: 50,
    page: 2,
  });
  assert.equal(calls[0]?.params.branch, "main");
  assert.equal(calls[0]?.params.status, "failure");
  assert.equal(calls[0]?.params.per_page, 50);
  assert.equal(calls[0]?.params.page, 2);
});

test("gh.workflow_runs_list: hasNextPage true when total exceeds page * per_page", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs": {
      total_count: 200,
      workflow_runs: [sampleRawRun, { ...sampleRawRun, id: 5_000_000_002 }],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunsListTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    perPage: 30,
    page: 1,
  })) as { hasNextPage: boolean };
  assert.equal(out.hasNextPage, true);
});

test("gh.workflow_runs_list: in-flight run reports state: in_progress (status overrides null conclusion)", async () => {
  const inFlight = {
    ...sampleRawRun,
    status: "in_progress",
    conclusion: null,
  };
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs": {
      total_count: 1,
      workflow_runs: [inFlight],
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunsListTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({ repo: "owner/repo" })) as {
    items: Array<{ state: string }>;
  };
  assert.equal(out.items[0]?.state, "in_progress");
});

test("gh.workflow_runs_list: rejects malformed status enum at the input boundary", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /repos/{owner}/{repo}/actions/runs": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunsListTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", status: "wonky" }),
    /gh\.workflow_runs_list input/,
  );
});
