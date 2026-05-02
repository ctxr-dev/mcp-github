// tests/unit/tools/workflow/_fixtures.ts
//
// Stub helpers for the gh.workflow_* tool tests. Workflow tools
// take an `AuthedRequest` (REST) rather than a `GraphqlClient`,
// so the stub shape differs from the issue/pr/label fixtures:
// dispatch by HTTP method + path, return `{ data, headers,
// status }`.

import type { AuthedRequest } from "../../../../src/auth/octokit.ts";

export interface RestCall {
  route: string;
  params: Record<string, unknown>;
}

interface StubResponse {
  data: unknown;
  status?: number;
}

// Build an `authedRequest` stub that dispatches by route string.
// Each entry is either a value (returned directly as `data`) or
// a function (called with the request params). Routes outside
// the fixture map throw — every test must declare every endpoint
// its handler will hit.
export function stubAuthedRequest(
  fixtures: Record<
    string,
    | unknown
    | ((params: Record<string, unknown>) => unknown | Promise<unknown>)
  >,
): { authedRequest: AuthedRequest; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const authedRequest = (async (
    route: string,
    params: Record<string, unknown> = {},
  ) => {
    calls.push({ route, params });
    if (!(route in fixtures)) {
      throw new Error(
        `tests: stubAuthedRequest saw unmocked route: ${route}`,
      );
    }
    const entry = fixtures[route];
    let data: unknown;
    if (typeof entry === "function") {
      data = await (entry as (p: Record<string, unknown>) => unknown)(
        params,
      );
    } else {
      data = entry;
    }
    return { data, status: 200, headers: {}, url: route } as StubResponse;
  }) as unknown as AuthedRequest;
  return { authedRequest, calls };
}

// Build a stub that throws an HTTP error with a given status
// code. Used to exercise the 404 / 409 branches in the workflow
// handlers without dragging the full @octokit/request-error
// shape into every test.
export function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// Canonical RawRun fixture — override fields per test by spread.
export const sampleRawRun = {
  id: 5_000_000_001,
  html_url: "https://github.com/owner/repo/actions/runs/5000000001",
  url: "https://api.github.com/repos/owner/repo/actions/runs/5000000001",
  name: "CI",
  display_title: "feat: thing",
  workflow_name: "ci.yml",
  head_branch: "feat/x",
  status: "completed",
  conclusion: "success",
  event: "pull_request",
  run_attempt: 1,
  head_sha: "deadbeef",
  actor: { login: "alice" },
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:01:30Z",
  run_started_at: "2026-04-01T00:00:30Z",
};

// Canonical RawJob fixture used by run_view + run_jobs tests.
export const sampleRawJob = {
  id: 9_000_000_001,
  name: "build",
  status: "completed",
  conclusion: "success",
  started_at: "2026-04-01T00:00:30Z",
  completed_at: "2026-04-01T00:01:25Z",
  html_url: "https://github.com/owner/repo/actions/runs/5000000001/jobs/9000000001",
  url: "https://api.github.com/repos/owner/repo/actions/jobs/9000000001",
  run_attempt: 1,
  steps: [
    {
      name: "Set up job",
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: "2026-04-01T00:00:30Z",
      completed_at: "2026-04-01T00:00:35Z",
    },
    {
      name: "Run tests",
      number: 2,
      status: "completed",
      conclusion: "success",
      started_at: "2026-04-01T00:00:35Z",
      completed_at: "2026-04-01T00:01:25Z",
    },
  ],
};
