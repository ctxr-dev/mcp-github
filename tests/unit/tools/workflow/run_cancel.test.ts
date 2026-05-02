// tests/unit/tools/workflow/run_cancel.test.ts
//
// gh.workflow_run_cancel: pin the POST + 202 happy path, the
// 404 / 409 → structured error translations, and the
// asynchronous-cancellation contract documented in the tool
// description.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerWorkflowRunCancelTool } from "../../../../src/tools/workflow/run_cancel.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { httpError, stubAuthedRequest } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.workflow_run_cancel") throw new Error(`unexpected: ${name}`);
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

test("gh.workflow_run_cancel: POSTs to the cancel endpoint, returns {cancelled: true, run_id}", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    // REST returns an empty body on 202 Accepted; we don't
    // read it.
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel": {},
  });
  const reg = captureRegistration();
  registerWorkflowRunCancelTool(reg.register, authedRequest);
  const out = await reg.entry.handler({
    repo: "owner/repo",
    run_id: 5_000_000_001,
  });
  assert.deepEqual(out, { cancelled: true, run_id: 5_000_000_001 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params.run_id, 5_000_000_001);
});

test("gh.workflow_run_cancel: 404 → 'run not found'", async () => {
  const { authedRequest } = stubAuthedRequest({
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel": () => {
      throw httpError(404);
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunCancelTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", run_id: 99 }),
    /run owner\/repo#99 not found/,
  );
});

test("gh.workflow_run_cancel: 409 → 'already in a terminal state'", async () => {
  // 409 Conflict happens when the caller tries to cancel a run
  // that has already completed / cancelled / errored. Translate
  // to a clean message — the generic GitHub 409 body would
  // otherwise look like a transport problem.
  const { authedRequest } = stubAuthedRequest({
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel": () => {
      throw httpError(409);
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunCancelTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", run_id: 1 }),
    /already in a terminal state and cannot be cancelled/,
  );
});

test("gh.workflow_run_cancel: other HTTP errors propagate unchanged", async () => {
  // 5xx and other unexpected statuses should bubble up as-is so
  // the caller sees the original error rather than a wrapped
  // tool-scoped one.
  const { authedRequest } = stubAuthedRequest({
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel": () => {
      throw httpError(503, "Service Unavailable");
    },
  });
  const reg = captureRegistration();
  registerWorkflowRunCancelTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", run_id: 1 }),
    /Service Unavailable/,
  );
});
