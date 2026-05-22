// tests/unit/tools/pr/view.test.ts
//
// gh.pr_view: pin the canonical PRSummary shape (heavier than
// IssueSummary because it rolls in reviews + review-comment count
// + status-check rollup) plus the repo-vs-PR error distinction.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  _setClock,
  _setSleeper,
  registerPRViewTool,
} from "../../../../src/tools/pr/view.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawPR, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_view") throw new Error(`unexpected: ${name}`);
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

test("gh.pr_view: maps a full GraphQL response onto the canonical PRSummary", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/view": { repository: { pullRequest: sampleRawPR } },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo", number: 7 })) as {
    number: number;
    base: string;
    head: string;
    review_decision: string | null;
    review_comments_count: number;
    status_checks_state: string | null;
    status_checks: Array<{ context: string; state: string }>;
    reviews: Array<{
      author: string | null;
      state: string;
      submitted_at: string | null;
    }>;
  };
  assert.equal(out.number, 7);
  assert.equal(out.base, "main");
  assert.equal(out.head, "feat/x");
  assert.equal(out.review_decision, "APPROVED");
  // 3 + 0 = 3 review-comments across two threads.
  assert.equal(out.review_comments_count, 3);
  assert.equal(out.status_checks_state, "SUCCESS");
  assert.deepEqual(
    out.status_checks.map((c) => c.context),
    ["ci/build", "ci/legacy"],
  );
  assert.deepEqual(out.reviews, [
    {
      author: "carol",
      state: "APPROVED",
      submitted_at: "2026-04-02T01:00:00Z",
    },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.vars, {
    owner: "owner",
    name: "repo",
    number: 7,
  });
});

test("gh.pr_view: distinguishes repo-not-found from PR-not-found", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/view": { repository: null },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 7 }),
    /repository 'owner\/repo' not found or token lacks read access/,
  );
});

test("gh.pr_view: throws PR-not-found when repo exists but PR doesn't", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/view": { repository: { pullRequest: null } },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99 }),
    /PR owner\/repo#99 not found/,
  );
});

test("gh.pr_view: maps CheckRun + StatusContext onto the unified status_checks shape", async () => {
  // CheckRun.conclusion="FAILURE" → state: "FAILURE"; an
  // in-progress CheckRun with null conclusion + status="QUEUED"
  // maps to "PENDING" so consumers don't have to branch on
  // __typename + status independently.
  const customPR = {
    ...sampleRawPR,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "PENDING" as const,
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "ci/lint",
                    conclusion: "FAILURE" as const,
                    status: "COMPLETED" as const,
                  },
                  {
                    __typename: "CheckRun",
                    name: "ci/test",
                    conclusion: null,
                    status: "QUEUED" as const,
                  },
                ],
              },
            },
          },
        },
      ],
    },
  };
  const { graphql } = stubGraphqlClient({
    "pr/view": { repository: { pullRequest: customPR } },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo", number: 7 })) as {
    status_checks: Array<{ context: string; state: string }>;
  };
  assert.deepEqual(out.status_checks, [
    { context: "ci/lint", state: "FAILURE" },
    { context: "ci/test", state: "PENDING" },
  ]);
});

test("gh.pr_view: review_decision: null passes through (no branch-protection review requirement)", async () => {
  // A PR against a base with no branch-protection rule returns
  // reviewDecision: null. Methodology must NOT mistake null for
  // "REVIEW_REQUIRED" — the absence of a requirement is not the
  // same as a pending one.
  const customPR = { ...sampleRawPR, reviewDecision: null };
  const { graphql } = stubGraphqlClient({
    "pr/view": { repository: { pullRequest: customPR } },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo", number: 7 })) as {
    review_decision: string | null;
  };
  assert.equal(out.review_decision, null);
});

test("gh.pr_view: each review_decision enum value passes through unchanged", async () => {
  for (const decision of ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const) {
    const customPR = { ...sampleRawPR, reviewDecision: decision };
    const { graphql } = stubGraphqlClient({
      "pr/view": { repository: { pullRequest: customPR } },
    });
    const reg = captureRegistration();
    registerPRViewTool(reg.register, graphql);
    const out = (await reg.entry.handler({ repo: "owner/repo", number: 7 })) as {
      review_decision: string | null;
    };
    assert.equal(out.review_decision, decision);
  }
});

test("gh.pr_view: PENDING review with null submittedAt passes through as null", async () => {
  // A reviewer who started but didn't submit a review surfaces
  // as { state: "PENDING", submitted_at: null }. The methodology's
  // "fresh review on new HEAD" check skips PENDING reviews.
  const customPR = {
    ...sampleRawPR,
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          state: "PENDING" as const,
          author: { login: "draft-reviewer" },
          submittedAt: null,
        },
      ],
    },
  };
  const { graphql } = stubGraphqlClient({
    "pr/view": { repository: { pullRequest: customPR } },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo", number: 7 })) as {
    reviews: Array<{ submitted_at: string | null; state: string }>;
  };
  assert.equal(out.reviews[0]?.state, "PENDING");
  assert.equal(out.reviews[0]?.submitted_at, null);
});

// Build a deterministic test clock + sleeper that advance virtual
// time on each sleep. Used by the wait_for_mergeable tests so the
// suite doesn't actually wait 5+ seconds per case.
function makeFakeTimeControls(initialMs = 1_000_000) {
  let now = initialMs;
  const sleeper = async (ms: number) => {
    now += ms;
  };
  const clock = () => now;
  return { sleeper, clock };
}

test("gh.pr_view: wait_for_mergeable polls until mergeable resolves, then returns", async () => {
  const { sleeper, clock } = makeFakeTimeControls();
  _setSleeper(sleeper);
  _setClock(clock);
  try {
    let call = 0;
    const { graphql, calls } = stubGraphqlClient({
      "pr/view": () => {
        call += 1;
        // Calls 1+2 return UNKNOWN; call 3 returns MERGEABLE.
        const mergeable = call < 3 ? "UNKNOWN" : "MERGEABLE";
        return {
          repository: { pullRequest: { ...sampleRawPR, mergeable } },
        };
      },
    });
    const reg = captureRegistration();
    registerPRViewTool(reg.register, graphql);
    const out = (await reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      wait_for_mergeable: { timeout_seconds: 30, poll_interval_seconds: 5 },
    })) as { mergeable: string };
    assert.equal(out.mergeable, "MERGEABLE");
    // 3 GraphQL calls: initial + 2 retries.
    assert.equal(calls.length, 3);
  } finally {
    _setSleeper(null);
    _setClock(null);
  }
});

test("gh.pr_view: wait_for_mergeable times out and returns last payload as UNKNOWN", async () => {
  const { sleeper, clock } = makeFakeTimeControls();
  _setSleeper(sleeper);
  _setClock(clock);
  try {
    const { graphql, calls } = stubGraphqlClient({
      "pr/view": () => ({
        repository: {
          pullRequest: { ...sampleRawPR, mergeable: "UNKNOWN" },
        },
      }),
    });
    const reg = captureRegistration();
    registerPRViewTool(reg.register, graphql);
    const out = (await reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      wait_for_mergeable: { timeout_seconds: 10, poll_interval_seconds: 5 },
    })) as { mergeable: string };
    // Stayed UNKNOWN; tool returned cleanly, didn't throw.
    assert.equal(out.mergeable, "UNKNOWN");
    // Initial fetch + retries within the 10s budget. After the
    // post-sleep deadline-recheck (A9 fix), the second sleep ends
    // exactly at t=10 and the loop breaks before kicking off
    // another fetch — so 1 initial + 1 retry = 2 calls.
    assert.equal(calls.length, 2);
  } finally {
    _setSleeper(null);
    _setClock(null);
  }
});

test("gh.pr_view: wait_for_mergeable defaults to 30s timeout, 5s interval", async () => {
  const { sleeper, clock } = makeFakeTimeControls();
  _setSleeper(sleeper);
  _setClock(clock);
  try {
    const { graphql, calls } = stubGraphqlClient({
      "pr/view": () => ({
        repository: {
          pullRequest: { ...sampleRawPR, mergeable: "UNKNOWN" },
        },
      }),
    });
    const reg = captureRegistration();
    registerPRViewTool(reg.register, graphql);
    await reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      wait_for_mergeable: {},
    });
    // 30s / 5s budget. After the post-sleep deadline-recheck
    // (A9 fix), the sixth sleep ends exactly at t=30 and the
    // loop breaks without a final fetch — so 1 initial + 5
    // retries = 6 calls.
    assert.equal(calls.length, 6);
  } finally {
    _setSleeper(null);
    _setClock(null);
  }
});

test("gh.pr_view: no wait_for_mergeable → single fetch even if mergeable is UNKNOWN", async () => {
  // The default behaviour is a single round-trip; polling is
  // explicit opt-in.
  const { graphql, calls } = stubGraphqlClient({
    "pr/view": () => ({
      repository: {
        pullRequest: { ...sampleRawPR, mergeable: "UNKNOWN" },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
  })) as { mergeable: string };
  assert.equal(out.mergeable, "UNKNOWN");
  assert.equal(calls.length, 1);
});

test("gh.pr_view: rejects timeout_seconds > 120 at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      wait_for_mergeable: { timeout_seconds: 999 },
    }),
    /gh\.pr_view input/,
  );
});

test("gh.pr_view: rejects poll_interval_seconds > 30 at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      wait_for_mergeable: { poll_interval_seconds: 60 },
    }),
    /gh\.pr_view input/,
  );
});

test("gh.pr_view: status_checks_state is null when there's no rollup", async () => {
  // Brand-new PRs without commits, or PRs against a base with no
  // CI configured, return statusCheckRollup: null.
  const customPR = {
    ...sampleRawPR,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  };
  const { graphql } = stubGraphqlClient({
    "pr/view": { repository: { pullRequest: customPR } },
  });
  const reg = captureRegistration();
  registerPRViewTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo", number: 7 })) as {
    status_checks_state: string | null;
    status_checks: Array<unknown>;
  };
  assert.equal(out.status_checks_state, null);
  assert.deepEqual(out.status_checks, []);
});
