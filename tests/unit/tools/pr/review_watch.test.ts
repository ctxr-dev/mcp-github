// tests/unit/tools/pr/review_watch.test.ts
//
// gh.pr_review_watch: pin the per-reviewer verdict truth table
// (DISMISSED / PENDING excluded; threads-by-author drive
// needs-work; APPROVED gating via requiredApprovals), the strict
// `ready` predicate (all-green + required approvals + CI), the
// transition (fingerprint) wake semantics (fires on change, does
// NOT re-fire on unchanged state), the `any` / `smart` / `all` /
// `quorum` filters, the multiplex changed-PR reporting, the
// single-shot (maxWaitSeconds:0) + timeout + abort-signal paths,
// the rate-limit snapshot, per-PR error isolation, and the input
// bounds.
//
// All per-cycle GraphQL calls share the `pr/review_watch` query
// name, so the multi-cycle tests make the stub's handler a closure
// over an external cycle counter that returns different responses
// across cycles. `sleep` resolves immediately and `now` is driven
// by a controllable clock so the suite never actually waits.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePr,
  registerPRReviewWatchTool,
  watchPrs,
} from "../../../../src/tools/pr/review_watch.ts";
import {
  AbuseDetectionError,
  RateLimitExhaustedError,
} from "../../../../src/graphql/errors.ts";
import type { GraphqlClient } from "../../../../src/graphql/client.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

const HEAD = "headsha1";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_review_watch") throw new Error(`unexpected: ${name}`);
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

// Build one raw review node (latestReviews connection shape). The
// `login` shorthand maps onto the nested `author.login`; pass
// `author` directly to override the whole object (e.g. a null
// author).
function review(
  overrides: Record<string, unknown> & { login?: string } = {},
) {
  const { login, ...rest } = overrides;
  const node: Record<string, unknown> = {
    id: "PRR_1",
    author: { login: login ?? "alice" },
    state: "APPROVED" as const,
    commit: { oid: HEAD },
    submittedAt: "2026-05-01T00:00:00Z",
    ...rest,
  };
  return node;
}

// Build one raw review thread (reviewThreads connection shape).
function thread(
  authorLogin: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "RT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/x.ts",
    line: 10,
    comments: { nodes: [{ author: { login: authorLogin }, body: "fix this" }] },
    ...overrides,
  };
}

// Assemble a full RawPR. `reviews` / `threads` default to empty so
// each test only declares what it cares about.
function rawPr(opts: {
  head?: string;
  reviewDecision?:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "REVIEW_REQUIRED"
    | null;
  reviews?: Array<Record<string, unknown>>;
  threads?: Array<Record<string, unknown>>;
  threadsHasNextPage?: boolean;
  rollup?: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
  noRollup?: boolean;
} = {}) {
  const rollupNode = opts.noRollup
    ? { commit: { statusCheckRollup: null } }
    : {
        commit: {
          statusCheckRollup: { state: opts.rollup ?? "SUCCESS" },
        },
      };
  return {
    headRefOid: opts.head ?? HEAD,
    reviewDecision: opts.reviewDecision ?? "APPROVED",
    latestReviews: { nodes: opts.reviews ?? [] },
    reviewThreads: {
      pageInfo: {
        hasNextPage: opts.threadsHasNextPage ?? false,
        endCursor: null,
      },
      nodes: opts.threads ?? [],
    },
    commits: { nodes: [rollupNode] },
  } as unknown as Parameters<typeof evaluatePr>[0];
}

// A sleep that resolves immediately; a clock the test can advance.
function makeDeps(
  graphql: GraphqlClient,
  extras: {
    nowSeq?: number[];
    aborted?: { aborted: boolean };
    onSleep?: () => void;
  } = {},
) {
  // When a sequence of `now()` values is supplied, return them in
  // order (clamping to the last). Otherwise return a fixed clock so
  // maxWaitSeconds windows never elapse on their own.
  let i = 0;
  const seq = extras.nowSeq;
  const now = () => {
    if (!seq) return 1_000_000;
    const v = seq[Math.min(i, seq.length - 1)] ?? 0;
    i += 1;
    return v;
  };
  const deps: Parameters<typeof watchPrs>[1] = {
    graphql,
    sleep: async () => {
      extras.onSleep?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    now,
  };
  if (extras.aborted) deps.signal = extras.aborted;
  return deps;
}

// ---------------------------------------------------------------
// evaluatePr: verdict truth table
// ---------------------------------------------------------------

test("evaluatePr: no review for reviewer -> pending", () => {
  const ev = evaluatePr(rawPr({ reviews: [] }), {
    reviewers: ["alice"],
    requiredApprovals: [],
    requireCi: false,
  });
  assert.equal(ev.reviewers[0]?.verdict, "pending");
  assert.equal(ev.reviewers[0]?.onHead, false);
  assert.equal(ev.allOnHead, false);
  assert.equal(ev.ready, false);
});

test("evaluatePr: DISMISSED review is excluded (reads pending, not green)", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "DISMISSED" })] }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "pending");
  assert.equal(ev.reviewers[0]?.onHead, false);
});

test("evaluatePr: PENDING review is excluded (null commit, reads pending)", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "PENDING", commit: null, submittedAt: null })] }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "pending");
});

test("evaluatePr: review on an old commit -> pending (not on head)", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ commit: { oid: "oldsha" } })] }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "pending");
  assert.equal(ev.reviewers[0]?.onHead, false);
});

test("evaluatePr: CHANGES_REQUESTED on head -> needs-work", () => {
  const ev = evaluatePr(
    rawPr({
      reviews: [review({ state: "CHANGES_REQUESTED" })],
      reviewDecision: "CHANGES_REQUESTED",
    }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "needs-work");
  assert.equal(ev.reviewers[0]?.onHead, true);
  assert.equal(ev.actionable, true);
});

test("evaluatePr: unresolved non-outdated thread by reviewer -> needs-work (even if COMMENTED)", () => {
  // Copilot's signal: COMMENTED state, but an open thread it authored.
  const ev = evaluatePr(
    rawPr({
      reviews: [review({ state: "COMMENTED" })],
      threads: [thread("alice")],
    }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "needs-work");
  assert.equal(ev.actionable, true);
  assert.equal(ev.unresolvedByReviewer["alice"], 1);
});

test("evaluatePr: resolved or outdated threads do NOT drive needs-work", () => {
  const ev = evaluatePr(
    rawPr({
      reviews: [review({ state: "COMMENTED" })],
      threads: [
        thread("alice", { isResolved: true }),
        thread("alice", { isOutdated: true }),
      ],
    }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  // COMMENTED + no open thread + not required-to-approve -> green.
  assert.equal(ev.reviewers[0]?.verdict, "green");
  assert.equal(ev.unresolvedByReviewer["alice"], undefined);
});

test("evaluatePr: open thread by a DIFFERENT author does not make this reviewer needs-work", () => {
  const ev = evaluatePr(
    rawPr({
      reviews: [review({ login: "alice", state: "COMMENTED" })],
      threads: [thread("bob")],
    }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "green");
  assert.equal(ev.unresolvedByReviewer["bob"], 1);
  assert.equal(ev.unresolvedByReviewer["alice"], undefined);
});

test("evaluatePr: COMMENTED on head, no open thread, not required -> green", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "COMMENTED" })] }),
    { reviewers: ["alice"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "green");
});

test("evaluatePr: required approver that only COMMENTED stays pending (not green)", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "COMMENTED" })] }),
    { reviewers: ["alice"], requiredApprovals: ["alice"], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "pending");
  assert.equal(ev.ready, false);
});

test("evaluatePr: required approver that APPROVED on head -> green + ready", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "APPROVED" })] }),
    { reviewers: ["alice"], requiredApprovals: ["alice"], requireCi: false },
  );
  assert.equal(ev.reviewers[0]?.verdict, "green");
  assert.equal(ev.ready, true);
  assert.equal(ev.allOnHead, true);
});

// ---------------------------------------------------------------
// evaluatePr: ready aggregate (all-green + required approvals + CI)
// ---------------------------------------------------------------

test("evaluatePr: ready false when one of two reviewers is pending", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ login: "alice", state: "APPROVED" })] }),
    { reviewers: ["alice", "bob"], requiredApprovals: [], requireCi: false },
  );
  assert.equal(ev.ready, false);
  assert.equal(ev.reviewers.find((r) => r.login === "bob")?.verdict, "pending");
});

test("evaluatePr: requireCi + SUCCESS rollup -> ready", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "APPROVED" })], rollup: "SUCCESS" }),
    { reviewers: ["alice"], requiredApprovals: ["alice"], requireCi: true },
  );
  assert.equal(ev.ci, "SUCCESS");
  assert.equal(ev.ready, true);
});

test("evaluatePr: requireCi + FAILURE rollup -> not ready", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "APPROVED" })], rollup: "FAILURE" }),
    { reviewers: ["alice"], requiredApprovals: ["alice"], requireCi: true },
  );
  assert.equal(ev.ready, false);
});

test("evaluatePr: null rollup passes ready when requireCi is false", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "APPROVED" })], noRollup: true }),
    { reviewers: ["alice"], requiredApprovals: ["alice"], requireCi: false },
  );
  assert.equal(ev.ci, null);
  assert.equal(ev.ready, true);
});

test("evaluatePr: null rollup fails ready when requireCi is true", () => {
  const ev = evaluatePr(
    rawPr({ reviews: [review({ state: "APPROVED" })], noRollup: true }),
    { reviewers: ["alice"], requiredApprovals: ["alice"], requireCi: true },
  );
  assert.equal(ev.ci, null);
  assert.equal(ev.ready, false);
});

// ---------------------------------------------------------------
// evaluatePr: fingerprint stability
// ---------------------------------------------------------------

test("evaluatePr: fingerprint is stable across identical evaluations", () => {
  const opts = { reviewers: ["alice"], requiredApprovals: [], requireCi: false };
  const a = evaluatePr(rawPr({ reviews: [review()] }), opts);
  const b = evaluatePr(rawPr({ reviews: [review()] }), opts);
  assert.equal(a.fingerprint, b.fingerprint);
});

test("evaluatePr: fingerprint changes when a verdict changes", () => {
  const opts = { reviewers: ["alice"], requiredApprovals: [], requireCi: false };
  const pending = evaluatePr(rawPr({ reviews: [] }), opts);
  const green = evaluatePr(rawPr({ reviews: [review()] }), opts);
  assert.notEqual(pending.fingerprint, green.fingerprint);
});

test("evaluatePr: fingerprint changes when the CI state changes", () => {
  const opts = { reviewers: ["alice"], requiredApprovals: [], requireCi: false };
  const a = evaluatePr(rawPr({ reviews: [review()], rollup: "SUCCESS" }), opts);
  const b = evaluatePr(rawPr({ reviews: [review()], rollup: "PENDING" }), opts);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

// ---------------------------------------------------------------
// watchPrs: single-shot, timeout, wake
// ---------------------------------------------------------------

const ONE_PR = [{ repo: "owner/repo", number: 7 }];

function baseOpts(overrides: Partial<Parameters<typeof watchPrs>[0]> = {}) {
  return {
    prs: ONE_PR,
    reviewers: ["alice"],
    requiredApprovals: [],
    waitFor: "any" as const,
    quorum: 1,
    sinceFingerprint: null,
    pollSeconds: 15,
    maxWaitSeconds: 25,
    requireCi: false,
    ...overrides,
  };
}

test("watchPrs: maxWaitSeconds 0 takes a single snapshot and returns timedOut", async () => {
  // A not-yet-ready snapshot: maxWaitSeconds:0 polls exactly once
  // and returns timedOut without blocking (the caller re-invokes
  // with the fingerprint).
  let cycles = 0;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return { repository: { pullRequest: rawPr({ reviews: [] }) } };
    },
  });
  const out = await watchPrs(
    baseOpts({ maxWaitSeconds: 0 }),
    makeDeps(graphql),
  );
  assert.equal(cycles, 1);
  assert.equal(out.timedOut, true);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.reviewers[0]?.verdict, "pending");
});

test("watchPrs: maxWaitSeconds 0 with a ready snapshot returns ready (not timedOut)", async () => {
  // A single snapshot that is already done returns immediately with
  // ready and timedOut:false, so the agent stops looping.
  let cycles = 0;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return {
        repository: {
          pullRequest: rawPr({ reviews: [review({ state: "APPROVED" })] }),
        },
      };
    },
  });
  const out = await watchPrs(
    baseOpts({ requiredApprovals: ["alice"], maxWaitSeconds: 0 }),
    makeDeps(graphql),
  );
  assert.equal(cycles, 1);
  assert.equal(out.timedOut, false);
  assert.equal(out.items[0]?.ready, true);
});

test("watchPrs: ready wakes immediately even on the first call (no sinceFingerprint)", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({ reviews: [review({ state: "APPROVED" })] }),
      },
    }),
  });
  const out = await watchPrs(
    baseOpts({ requiredApprovals: ["alice"], maxWaitSeconds: 25 }),
    makeDeps(graphql),
  );
  assert.equal(out.timedOut, false);
  assert.equal(out.items[0]?.ready, true);
  assert.deepEqual(out.changed, [
    { repo: "owner/repo", number: 7, reason: "ready" },
  ]);
});

test("watchPrs: transition wake fires when fingerprint changes vs sinceFingerprint", async () => {
  // Snapshot the pending fingerprint first.
  const { graphql: g1 } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: { pullRequest: rawPr({ reviews: [] }) },
    }),
  });
  const first = await watchPrs(
    baseOpts({ maxWaitSeconds: 0 }),
    makeDeps(g1),
  );
  const pendingFp = first.fingerprint;

  // Now alice is on head but requested changes: a real transition
  // away from pendingFp that is NOT ready, so `any` wakes with the
  // generic "transition" reason rather than "ready".
  let cycles = 0;
  const { graphql: g2 } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return {
        repository: {
          pullRequest: rawPr({
            reviews: [review({ state: "CHANGES_REQUESTED" })],
            reviewDecision: "CHANGES_REQUESTED",
          }),
        },
      };
    },
  });
  const out = await watchPrs(
    baseOpts({ sinceFingerprint: pendingFp, maxWaitSeconds: 25 }),
    makeDeps(g2),
  );
  assert.equal(cycles, 1);
  assert.equal(out.timedOut, false);
  assert.equal(out.items[0]?.ready, false);
  assert.equal(out.changed[0]?.reason, "transition");
  assert.notEqual(out.fingerprint, pendingFp);
});

test("watchPrs: transition wake does NOT re-fire on unchanged state (times out)", async () => {
  // Capture a stable not-ready (needs-work) fingerprint. A non-ready
  // state is required here: `ready` always wakes regardless of the
  // fingerprint, so a green state could not exercise the
  // "unchanged -> no wake" path.
  const stable = () => ({
    repository: {
      pullRequest: rawPr({
        reviews: [review({ state: "CHANGES_REQUESTED" })],
        reviewDecision: "CHANGES_REQUESTED",
      }),
    },
  });
  const { graphql: g1 } = stubGraphqlClient({ "pr/review_watch": stable });
  const first = await watchPrs(baseOpts({ maxWaitSeconds: 0 }), makeDeps(g1));
  const stableFp = first.fingerprint;

  // Re-poll with the same state; the clock advances past the budget
  // so the loop times out instead of hot-looping.
  let cycles = 0;
  const { graphql: g2 } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return stable();
    },
  });
  const out = await watchPrs(
    baseOpts({ sinceFingerprint: stableFp, maxWaitSeconds: 30, pollSeconds: 15 }),
    // now() sequence: deadline base, first check, post-sleep check.
    makeDeps(g2, { nowSeq: [0, 0, 31_000] }),
  );
  assert.equal(out.timedOut, true);
  assert.equal(out.changed.length, 0);
  assert.equal(out.fingerprint, stableFp);
  // One poll, then the post-sleep deadline check ends the loop.
  assert.equal(cycles, 1);
});

// ---------------------------------------------------------------
// watchPrs: waitFor filters
// ---------------------------------------------------------------

test("watchPrs: waitFor smart wakes on actionable but not on a benign change", async () => {
  // Baseline: pending.
  const optsEval = { reviewers: ["alice"], requiredApprovals: [], requireCi: false };
  const baseFp = evaluatePr(rawPr({ reviews: [] }), optsEval).fingerprint;

  // needs-work is actionable -> smart wakes.
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({
          reviews: [review({ state: "CHANGES_REQUESTED" })],
          reviewDecision: "CHANGES_REQUESTED",
        }),
      },
    }),
  });
  const out = await watchPrs(
    baseOpts({ waitFor: "smart", sinceFingerprint: baseFp, maxWaitSeconds: 25 }),
    makeDeps(graphql),
  );
  assert.equal(out.timedOut, false);
  assert.equal(out.changed[0]?.reason, "actionable");
});

test("watchPrs: waitFor smart does NOT wake on a non-actionable, non-ready change", async () => {
  // Baseline pending for a two-reviewer set; change makes only ONE
  // reviewer green (still not ready, not actionable) -> smart holds.
  const optsEval = {
    reviewers: ["alice", "bob"],
    requiredApprovals: [],
    requireCi: false,
  };
  const baseFp = evaluatePr(rawPr({ reviews: [] }), optsEval).fingerprint;

  let cycles = 0;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return {
        repository: {
          pullRequest: rawPr({
            reviews: [review({ login: "alice", state: "COMMENTED" })],
          }),
        },
      };
    },
  });
  const out = await watchPrs(
    baseOpts({
      prs: ONE_PR,
      reviewers: ["alice", "bob"],
      waitFor: "smart",
      sinceFingerprint: baseFp,
      maxWaitSeconds: 30,
      pollSeconds: 15,
    }),
    makeDeps(graphql, { nowSeq: [0, 0, 31_000] }),
  );
  assert.equal(out.timedOut, true);
  assert.equal(out.changed.length, 0);
  assert.equal(cycles, 1);
});

test("watchPrs: waitFor all wakes only once every reviewer is on head", async () => {
  const optsEval = {
    reviewers: ["alice", "bob"],
    requiredApprovals: [],
    requireCi: false,
  };
  const baseFp = evaluatePr(rawPr({ reviews: [] }), optsEval).fingerprint;

  // Both reviewers on head but requesting changes: allOnHead is
  // true (neither is pending) while the PR is NOT ready, so the
  // wake is attributable to the `all` filter, not to `ready`.
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({
          reviewDecision: "CHANGES_REQUESTED",
          reviews: [
            review({ id: "PRR_a", login: "alice", state: "CHANGES_REQUESTED" }),
            review({ id: "PRR_b", login: "bob", state: "CHANGES_REQUESTED" }),
          ],
        }),
      },
    }),
  });
  const out = await watchPrs(
    baseOpts({
      reviewers: ["alice", "bob"],
      waitFor: "all",
      sinceFingerprint: baseFp,
      maxWaitSeconds: 25,
    }),
    makeDeps(graphql),
  );
  assert.equal(out.timedOut, false);
  assert.equal(out.items[0]?.allOnHead, true);
  assert.equal(out.items[0]?.ready, false);
  assert.equal(out.changed[0]?.reason, "all-on-head");
});

test("watchPrs: waitFor quorum wakes when enough reviewers are non-pending", async () => {
  const optsEval = {
    reviewers: ["alice", "bob", "carol"],
    requiredApprovals: [],
    requireCi: false,
  };
  const baseFp = evaluatePr(rawPr({ reviews: [] }), optsEval).fingerprint;

  // alice + bob are on head (requesting changes -> non-pending);
  // carol has not reviewed (pending). Two non-pending reviewers hit
  // the quorum of 2 while the PR is not ready, so the wake is the
  // quorum filter rather than `ready`.
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({
          reviewDecision: "CHANGES_REQUESTED",
          reviews: [
            review({ id: "PRR_a", login: "alice", state: "CHANGES_REQUESTED" }),
            review({ id: "PRR_b", login: "bob", state: "CHANGES_REQUESTED" }),
          ],
        }),
      },
    }),
  });
  const out = await watchPrs(
    baseOpts({
      reviewers: ["alice", "bob", "carol"],
      waitFor: "quorum",
      quorum: 2,
      sinceFingerprint: baseFp,
      maxWaitSeconds: 25,
    }),
    makeDeps(graphql),
  );
  assert.equal(out.timedOut, false);
  assert.equal(out.items[0]?.ready, false);
  assert.equal(out.changed[0]?.reason, "quorum-reached");
});

test("watchPrs: waitFor quorum holds below the threshold", async () => {
  const optsEval = {
    reviewers: ["alice", "bob", "carol"],
    requiredApprovals: [],
    requireCi: false,
  };
  const baseFp = evaluatePr(rawPr({ reviews: [] }), optsEval).fingerprint;

  let cycles = 0;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return {
        repository: {
          pullRequest: rawPr({
            reviews: [review({ login: "alice", state: "COMMENTED" })],
          }),
        },
      };
    },
  });
  const out = await watchPrs(
    baseOpts({
      reviewers: ["alice", "bob", "carol"],
      waitFor: "quorum",
      quorum: 2,
      sinceFingerprint: baseFp,
      maxWaitSeconds: 30,
      pollSeconds: 15,
    }),
    makeDeps(graphql, { nowSeq: [0, 0, 31_000] }),
  );
  assert.equal(out.timedOut, true);
  assert.equal(cycles, 1);
});

// ---------------------------------------------------------------
// watchPrs: multiplex, abort, rate-limit, per-PR error isolation
// ---------------------------------------------------------------

test("watchPrs: multiplex returns the changed PR + reason among several", async () => {
  // Two PRs; only #8 becomes ready. The closure varies the payload
  // by PR number (read off the vars), and all calls share the
  // pr/review_watch query name.
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": (vars: Record<string, unknown>) => {
      const number = vars.number as number;
      if (number === 8) {
        return {
          repository: {
            pullRequest: rawPr({ reviews: [review({ state: "APPROVED" })] }),
          },
        };
      }
      return { repository: { pullRequest: rawPr({ reviews: [] }) } };
    },
  });
  const out = await watchPrs(
    baseOpts({
      prs: [
        { repo: "owner/repo", number: 7 },
        { repo: "owner/repo", number: 8 },
      ],
      requiredApprovals: ["alice"],
      maxWaitSeconds: 25,
    }),
    makeDeps(graphql),
  );
  assert.equal(out.timedOut, false);
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.changed, [
    { repo: "owner/repo", number: 8, reason: "ready" },
  ]);
  assert.equal(out.items.find((i) => i.number === 8)?.ready, true);
  assert.equal(out.items.find((i) => i.number === 7)?.ready, false);
});

test("watchPrs: abort signal breaks the loop and returns timedOut", async () => {
  const aborted = { aborted: true };
  let cycles = 0;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return { repository: { pullRequest: rawPr({ reviews: [] }) } };
    },
  });
  const out = await watchPrs(
    baseOpts({ maxWaitSeconds: 25 }),
    makeDeps(graphql, { aborted }),
  );
  // Aborted before the first cycle -> no GraphQL calls, timedOut.
  assert.equal(cycles, 0);
  assert.equal(out.timedOut, true);
  assert.equal(out.changed.length, 0);
});

test("watchPrs: abort mid-wait breaks before the next cycle", async () => {
  const aborted = { aborted: false };
  let cycles = 0;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      cycles += 1;
      return { repository: { pullRequest: rawPr({ reviews: [] }) } };
    },
  });
  // Flip the abort flag during the sleep; the post-sleep abort check
  // then breaks the loop. now() stays fixed so the deadline never
  // fires on its own.
  const out = await watchPrs(
    baseOpts({ maxWaitSeconds: 25, pollSeconds: 15 }),
    makeDeps(graphql, {
      aborted,
      onSleep: () => {
        aborted.aborted = true;
      },
    }),
  );
  assert.equal(cycles, 1);
  assert.equal(out.timedOut, true);
});

test("watchPrs: RateLimitExhaustedError returns a rateLimited snapshot, not a throw", async () => {
  const resetAt = Math.round(Date.now() / 1000) + 42;
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      throw new RateLimitExhaustedError(resetAt, 5000);
    },
  });
  const out = await watchPrs(baseOpts({ maxWaitSeconds: 25 }), makeDeps(graphql));
  assert.equal(out.rateLimited, true);
  assert.equal(out.timedOut, true);
  assert.equal(typeof out.retryAfter, "number");
  assert.ok((out.retryAfter ?? 0) >= 0);
});

test("watchPrs: AbuseDetectionError surfaces retryAfter from the error", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => {
      throw new AbuseDetectionError(60);
    },
  });
  const out = await watchPrs(baseOpts({ maxWaitSeconds: 25 }), makeDeps(graphql));
  assert.equal(out.rateLimited, true);
  assert.equal(out.retryAfter, 60);
});

test("watchPrs: a per-PR fetch error is isolated to that item, batch survives", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": (vars: Record<string, unknown>) => {
      const number = vars.number as number;
      if (number === 7) {
        // repo missing for this PR -> tool throws internally; the
        // engine captures it on the item.
        return { repository: null };
      }
      return {
        repository: {
          pullRequest: rawPr({ reviews: [review({ state: "APPROVED" })] }),
        },
      };
    },
  });
  const out = await watchPrs(
    baseOpts({
      prs: [
        { repo: "owner/repo", number: 7 },
        { repo: "owner/repo", number: 8 },
      ],
      requiredApprovals: ["alice"],
      maxWaitSeconds: 25,
    }),
    makeDeps(graphql),
  );
  const bad = out.items.find((i) => i.number === 7);
  const good = out.items.find((i) => i.number === 8);
  assert.match(bad?.error ?? "", /not found or token lacks read access/);
  assert.equal(good?.ready, true);
  // The healthy PR still wakes the multiplex.
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.changed, [
    { repo: "owner/repo", number: 8, reason: "ready" },
  ]);
});

// ---------------------------------------------------------------
// Handler: alias mapping, requiredApprovals default, input bounds
// ---------------------------------------------------------------

test("handler: maps the `copilot` alias to copilot-pull-request-reviewer", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({
          reviews: [
            review({ login: "copilot-pull-request-reviewer", state: "COMMENTED" }),
          ],
        }),
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    prs: [{ repo: "owner/repo", number: 7 }],
    reviewers: ["copilot"],
    maxWaitSeconds: 0,
  })) as {
    items: Array<{ reviewers: Array<{ login: string; verdict: string }> }>;
  };
  assert.equal(
    out.items[0]?.reviewers[0]?.login,
    "copilot-pull-request-reviewer",
  );
  // copilot is a bot, so it is NOT defaulted into requiredApprovals;
  // COMMENTED on head with no open thread reads green.
  assert.equal(out.items[0]?.reviewers[0]?.verdict, "green");
});

test("handler: requiredApprovals defaults to the human reviewers (copilot excluded)", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({
          reviews: [
            review({ id: "PRR_h", login: "alice", state: "COMMENTED" }),
            review({
              id: "PRR_c",
              login: "copilot-pull-request-reviewer",
              state: "COMMENTED",
            }),
          ],
        }),
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    prs: [{ repo: "owner/repo", number: 7 }],
    reviewers: ["alice", "copilot"],
    maxWaitSeconds: 0,
  })) as {
    items: Array<{
      ready: boolean;
      reviewers: Array<{ login: string; verdict: string }>;
    }>;
  };
  // alice (human) defaults into requiredApprovals: COMMENTED is not
  // APPROVED, so she stays pending and the PR is not ready.
  const alice = out.items[0]?.reviewers.find((r) => r.login === "alice");
  assert.equal(alice?.verdict, "pending");
  assert.equal(out.items[0]?.ready, false);
});

test("handler: threadsTruncated surfaces when reviewThreads has a next page", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/review_watch": () => ({
      repository: {
        pullRequest: rawPr({ reviews: [review()], threadsHasNextPage: true }),
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    prs: [{ repo: "owner/repo", number: 7 }],
    reviewers: ["alice"],
    maxWaitSeconds: 0,
  })) as { items: Array<{ threadsTruncated: boolean }> };
  assert.equal(out.items[0]?.threadsTruncated, true);
});

test("handler: rejects empty prs at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ prs: [], reviewers: ["alice"] }),
    /gh\.pr_review_watch input/,
  );
});

test("handler: rejects empty reviewers at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ prs: [{ repo: "owner/repo", number: 7 }], reviewers: [] }),
    /gh\.pr_review_watch input/,
  );
});

test("handler: rejects an unknown property on a prs item (additionalProperties:false)", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      prs: [{ repo: "owner/repo", number: 7, extra: true }],
      reviewers: ["alice"],
    }),
    /gh\.pr_review_watch input/,
  );
});

test("handler: rejects pollSeconds below the minimum", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      prs: [{ repo: "owner/repo", number: 7 }],
      reviewers: ["alice"],
      pollSeconds: 1,
    }),
    /gh\.pr_review_watch input/,
  );
});

test("handler: rejects maxWaitSeconds above the maximum", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      prs: [{ repo: "owner/repo", number: 7 }],
      reviewers: ["alice"],
      maxWaitSeconds: 999,
    }),
    /gh\.pr_review_watch input/,
  );
});

test("handler: rejects an invalid repo slug at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewWatchTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      prs: [{ repo: "not-a-slug", number: 7 }],
      reviewers: ["alice"],
    }),
    /gh\.pr_review_watch input/,
  );
});
