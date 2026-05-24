// src/tools/pr/review_watch.ts
//
// `gh.pr_review_watch`: a blocking, stateless, multiplexed
// long-poll that watches 1..N PRs for 1..N reviewers and returns
// when a wake condition fires for ANY watched PR. The agent
// re-invokes it in a foreground loop, passing the previous
// `fingerprint` back as `sinceFingerprint`, so each call wakes on a
// real transition (or on `ready` / timeout) rather than hot-looping.
//
// A blocking handler is safe here: the MCP SDK dispatches handlers
// via `Promise.resolve().then(...)`, so awaiting inside the handler
// does not stall the stdio read loop or other concurrent tool
// calls.
//
// The per-reviewer verdict is computed off `latestReviews` (latest
// review per author) plus unresolved, non-outdated review threads
// authored by the reviewer. We deliberately do NOT use any
// `review.comments.totalCount` field: it undercounts (it omits
// replies) and misses Copilot's thread-based findings (Copilot
// reviews are `COMMENTED` and can carry a non-empty summary with
// zero inline comments). The actionable signal is the unresolved
// non-outdated thread set, which also lines up with the
// methodology's "resolve the threads you fixed in the same push"
// invariant.
//
// `maxWaitSeconds` defaults to 25 deliberately: it stays under the
// ~60s MCP tool-call timeout common to clients (Cursor wobbles
// >30s). On timeout the tool returns a snapshot with `timedOut:
// true` and the agent re-invokes, passing the returned
// `fingerprint` back as `sinceFingerprint`. Power users can raise
// the client tool-timeout to lengthen each block.

import { createHash } from "node:crypto";

import type { GraphqlClient } from "../../graphql/client.js";
import { AbuseDetectionError, RateLimitExhaustedError } from "../../graphql/errors.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import { parseRepoSlug, repoSlugSchema } from "./_shared.js";

const POLL_SECONDS_DEFAULT = 15;
const POLL_SECONDS_MIN = 5;
const POLL_SECONDS_MAX = 120;
const MAX_WAIT_SECONDS_DEFAULT = 25;
const MAX_WAIT_SECONDS_MAX = 120;

// `copilot` is the alias the methodology uses everywhere; the real
// login GitHub resolves it to is `copilot-pull-request-reviewer`.
// We map it in the handler so the predicate (which matches against
// thread/review author logins) compares against the real login.
const COPILOT_ALIAS = "copilot";
const COPILOT_LOGIN = "copilot-pull-request-reviewer";

// Reviewer logins we treat as bots when defaulting `requiredApprovals`
// to "the human reviewers". Bots have no APPROVED state, so requiring
// one would make `ready` unreachable. The Copilot login is the only
// well-known bot reviewer in the methodology's set; the alias is also
// covered defensively in case the caller passes it unmapped.
const BOT_LOGINS = new Set<string>([COPILOT_LOGIN, COPILOT_ALIAS]);

const prItemSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

const inputSchema = {
  type: "object",
  required: ["prs", "reviewers"],
  properties: {
    prs: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: prItemSchema,
      description:
        "PRs to watch (max 20). Each poll cycle issues one GraphQL " +
        "request per PR in parallel, so the cap keeps a cycle's burst " +
        "well within GitHub's rate limits. The tool wakes when ANY of " +
        "them satisfies the wake condition.",
    },
    reviewers: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1 },
      description:
        "Individual reviewer logins to watch (users and bots; the alias " +
        "`copilot` maps to `copilot-pull-request-reviewer`). NOT team " +
        "slugs: the verdict matches a review/thread author login, so a " +
        "team slug never matches and would stay pending forever. Watch a " +
        "team via its member logins. A PR is `ready` only when every " +
        "reviewer here is green on HEAD.",
    },
    requiredApprovals: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1 },
      description:
        "Reviewers who must additionally be APPROVED (not merely " +
        "green) for `ready`. When omitted this defaults to the human " +
        "reviewers in `reviewers` (every reviewer except `copilot` / " +
        "bot logins), which avoids an all-green / zero-approvals state " +
        "that branch protection would still reject. Bots have no " +
        "APPROVED state, so listing one here would make `ready` " +
        "unreachable.",
    },
    waitFor: {
      type: "string",
      enum: ["any", "smart", "all", "quorum"],
      description:
        "Which transitions are wake-worthy (vs `sinceFingerprint`): " +
        "`any` (default) wakes on any change; `smart` only when the " +
        "PR is actionable or ready; `all` only when every reviewer is " +
        "on HEAD; `quorum` only when the count of non-pending " +
        "reviewers reaches `quorum`. `ready` and timeout always wake " +
        "regardless of this filter.",
    },
    quorum: {
      type: "integer",
      minimum: 1,
      description:
        "Only meaningful with `waitFor: quorum`: the number of " +
        "non-pending reviewers that wakes the watch.",
    },
    sinceFingerprint: {
      type: "string",
      description:
        "The `fingerprint` from the previous call. The tool wakes on a " +
        "`waitFor`-filtered transition away from this value. Omit on " +
        "the first call.",
    },
    pollSeconds: {
      type: "integer",
      minimum: POLL_SECONDS_MIN,
      maximum: POLL_SECONDS_MAX,
      description:
        `Seconds between poll cycles (default ${POLL_SECONDS_DEFAULT}, ` +
        `min ${POLL_SECONDS_MIN}, max ${POLL_SECONDS_MAX}).`,
    },
    maxWaitSeconds: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WAIT_SECONDS_MAX,
      description:
        `Max wall-clock seconds to block before returning with ` +
        `timedOut: true (default ${MAX_WAIT_SECONDS_DEFAULT}, max ` +
        `${MAX_WAIT_SECONDS_MAX}). 0 = take a single snapshot and ` +
        `return immediately. The default stays under the ~60s MCP ` +
        `tool-call timeout common to clients; re-invoke passing the ` +
        `returned fingerprint back as sinceFingerprint.`,
    },
    requireCi: {
      type: "boolean",
      description:
        "Default false. When true, `ready` additionally requires the " +
        "latest commit's status-check rollup state to be SUCCESS; a " +
        "null rollup (no checks configured) then fails `ready` with a " +
        "clear reason rather than passing.",
    },
  },
  additionalProperties: false,
} as const;

const reviewerVerdictSchema = {
  type: "object",
  required: ["login", "onHead", "verdict", "state", "latestReviewId"],
  properties: {
    login: { type: "string" },
    onHead: { type: "boolean" },
    verdict: { type: "string", enum: ["pending", "needs-work", "green"] },
    state: {
      type: ["string", "null"],
      enum: [
        "PENDING",
        "COMMENTED",
        "APPROVED",
        "CHANGES_REQUESTED",
        "DISMISSED",
        null,
      ],
    },
    latestReviewId: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

const itemSchema = {
  type: "object",
  required: [
    "repo",
    "number",
    "head",
    "reviewers",
    "actionable",
    "allOnHead",
    "ready",
    "ci",
    "reviewDecision",
    "unresolvedByReviewer",
    "threadsTruncated",
  ],
  properties: {
    repo: { type: "string" },
    number: { type: "integer" },
    head: { type: ["string", "null"] },
    reviewers: { type: "array", items: reviewerVerdictSchema },
    actionable: { type: "boolean" },
    allOnHead: { type: "boolean" },
    ready: { type: "boolean" },
    ci: { type: ["string", "null"] },
    reviewDecision: {
      type: ["string", "null"],
      enum: ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null],
    },
    unresolvedByReviewer: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
    threadsTruncated: { type: "boolean" },
    error: { type: "string" },
  },
  additionalProperties: false,
} as const;

const changedSchema = {
  type: "object",
  required: ["repo", "number", "reason"],
  properties: {
    repo: { type: "string" },
    number: { type: "integer" },
    reason: { type: "string" },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "changed", "fingerprint", "timedOut"],
  properties: {
    items: { type: "array", items: itemSchema },
    changed: { type: "array", items: changedSchema },
    fingerprint: { type: "string" },
    timedOut: { type: "boolean" },
    rateLimited: { type: "boolean" },
    retryAfter: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

type ReviewState =
  | "PENDING"
  | "COMMENTED"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "DISMISSED";

type RollupState =
  | "EXPECTED"
  | "ERROR"
  | "FAILURE"
  | "PENDING"
  | "SUCCESS";

interface PrInput {
  repo: string;
  number: number;
}

interface Input {
  prs: PrInput[];
  reviewers: string[];
  requiredApprovals?: string[];
  waitFor?: "any" | "smart" | "all" | "quorum";
  quorum?: number;
  sinceFingerprint?: string;
  pollSeconds?: number;
  maxWaitSeconds?: number;
  requireCi?: boolean;
}

// Normalised options the engine + evaluator actually consume.
interface WatchOptions {
  prs: PrInput[];
  reviewers: string[];
  requiredApprovals: string[];
  waitFor: "any" | "smart" | "all" | "quorum";
  quorum: number;
  sinceFingerprint: string | null;
  pollSeconds: number;
  maxWaitSeconds: number;
  requireCi: boolean;
}

interface EvalOptions {
  reviewers: string[];
  requiredApprovals: string[];
  requireCi: boolean;
}

interface RawReview {
  id: string;
  author: { login: string } | null;
  state: ReviewState;
  commit: { oid: string } | null;
}

interface RawThread {
  isResolved: boolean;
  isOutdated: boolean;
  comments: {
    nodes: Array<{ author: { login: string } | null }>;
  };
}

interface RawPR {
  headRefOid: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  latestReviews: { nodes: RawReview[] } | null;
  reviewThreads: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawThread[];
  };
  commits: {
    nodes: Array<{
      commit: { statusCheckRollup: { state: RollupState } | null };
    }>;
  };
}

interface Response {
  repository: { pullRequest: RawPR | null } | null;
}

interface ReviewerVerdict {
  login: string;
  onHead: boolean;
  verdict: "pending" | "needs-work" | "green";
  state: ReviewState | null;
  latestReviewId: string | null;
}

interface PrEvaluation {
  head: string | null;
  reviewers: ReviewerVerdict[];
  actionable: boolean;
  allOnHead: boolean;
  ready: boolean;
  ci: RollupState | null;
  reviewDecision: RawPR["reviewDecision"];
  unresolvedByReviewer: Record<string, number>;
  threadsTruncated: boolean;
  fingerprint: string;
}

interface OutputItem extends Omit<PrEvaluation, "fingerprint"> {
  repo: string;
  number: number;
  error?: string;
}

interface Output {
  items: OutputItem[];
  changed: Array<{ repo: string; number: number; reason: string }>;
  fingerprint: string;
  timedOut: boolean;
  rateLimited?: boolean;
  retryAfter?: number;
}

interface WatchDeps {
  graphql: GraphqlClient;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  signal?: { aborted: boolean } | undefined;
}

// PURE. Given one PR's raw GraphQL payload and the configured
// reviewer set, compute the per-reviewer verdict, the per-PR
// aggregates, and a stable fingerprint. No I/O, no clock; the
// engine and the unit suite both drive this directly.
export function evaluatePr(rawPr: RawPR, opts: EvalOptions): PrEvaluation {
  const head = rawPr.headRefOid;
  const latest = rawPr.latestReviews?.nodes ?? [];
  // latestReviews is one-per-author already, but index by login so
  // the per-reviewer lookup is O(1) and resilient to the connection
  // ever returning more than one node per author.
  const latestByLogin = new Map<string, RawReview>();
  for (const review of latest) {
    const login = review.author?.login;
    // Index by lowercased login: GitHub logins are case-insensitive and
    // the configured reviewer set is canonicalised the same way.
    if (login) latestByLogin.set(login.toLowerCase(), review);
  }

  // Count unresolved, non-outdated threads per authoring reviewer.
  // The author is the first comment's author (threads(first:1)).
  // This is the actionable-work signal: it equals the outstanding
  // asks the agent still owes the reviewer.
  const unresolvedByReviewer: Record<string, number> = {};
  for (const thread of rawPr.reviewThreads.nodes) {
    if (thread.isResolved || thread.isOutdated) continue;
    const author = thread.comments.nodes[0]?.author?.login;
    if (!author) continue;
    const key = author.toLowerCase();
    unresolvedByReviewer[key] = (unresolvedByReviewer[key] ?? 0) + 1;
  }

  const required = new Set(opts.requiredApprovals.map((l) => l.toLowerCase()));
  const reviewers: ReviewerVerdict[] = opts.reviewers.map((login) => {
    const review = latestByLogin.get(login.toLowerCase());
    const state = review?.state ?? null;
    const latestReviewId = review?.id ?? null;
    // On head only when this reviewer has a non-DISMISSED/PENDING
    // review whose commit is the current head. DISMISSED reviews
    // report commit==head with zero findings (would read falsely
    // green); PENDING reviews carry a null commit/submittedAt.
    const onHead =
      review !== undefined &&
      state !== "DISMISSED" &&
      state !== "PENDING" &&
      review.commit?.oid === head;

    let verdict: ReviewerVerdict["verdict"];
    if (!onHead) {
      verdict = "pending";
    } else {
      const hasOpenThread = (unresolvedByReviewer[login.toLowerCase()] ?? 0) > 0;
      if (state === "CHANGES_REQUESTED" || hasOpenThread) {
        verdict = "needs-work";
      } else {
        // On HEAD, no open thread, no requested changes: green. The
        // verdict reflects review FEEDBACK only. A required approver
        // who has not yet formally APPROVED is still green here (they
        // have no outstanding asks); the orthogonal requiredApproved
        // gate in `ready` holds the PR until they approve, so `green`
        // does not on its own imply `ready`.
        verdict = "green";
      }
    }
    return { login, onHead, verdict, state, latestReviewId };
  });

  const actionable = reviewers.some((r) => r.verdict === "needs-work");
  const allOnHead = reviewers.every((r) => r.verdict !== "pending");
  const ci = rawPr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;

  const allGreen = reviewers.every((r) => r.verdict === "green");
  const requiredApproved = reviewers
    .filter((r) => required.has(r.login.toLowerCase()))
    .every((r) => r.state === "APPROVED");
  // A null rollup means "no checks configured": pass unless
  // requireCi forces a gate, in which case null fails.
  const ciReady = opts.requireCi ? ci === "SUCCESS" : true;
  // Truncated threads mean only the first page was evaluated; a reviewer's
  // unresolved thread could be unseen, so never declare ready on partial
  // data (pessimistic: keep the caller looping rather than false-exiting).
  const threadsTruncated = rawPr.reviewThreads.pageInfo.hasNextPage;
  const ready = allGreen && requiredApproved && ciReady && !threadsTruncated;

  const fingerprint = computeFingerprint(
    reviewers,
    head,
    ci,
    unresolvedByReviewer,
    threadsTruncated,
    rawPr.reviewDecision,
  );

  return {
    head,
    reviewers,
    actionable,
    allOnHead,
    ready,
    ci,
    reviewDecision: rawPr.reviewDecision,
    unresolvedByReviewer,
    threadsTruncated,
    fingerprint,
  };
}

// Stable short hash over every field that drives the per-PR OUTPUT, so any
// observable change (verdict, latest-review id, head, ci, per-reviewer
// unresolved count, threadsTruncated, reviewDecision) moves the fingerprint
// and a waitFor:any transition wakes. The shape is fixed so the sibling
// methodology gh-CLI script can mirror it.
function computeFingerprint(
  reviewers: ReviewerVerdict[],
  head: string | null,
  ci: RollupState | null,
  unresolvedByReviewer: Record<string, number>,
  threadsTruncated: boolean,
  reviewDecision: RawPR["reviewDecision"],
): string {
  const sorted = [...reviewers].sort((a, b) => a.login.localeCompare(b.login));
  const tuples = sorted.map((r) => ({
    login: r.login,
    latestReviewId: r.latestReviewId,
    onHeadOid: r.onHead ? head : null,
    verdict: r.verdict,
    unresolved: unresolvedByReviewer[r.login.toLowerCase()] ?? 0,
  }));
  // `head` is included unconditionally (not only via on-head reviewers'
  // onHeadOid) so a push that moves HEAD always changes the fingerprint,
  // even when every reviewer is still pending.
  const payload = JSON.stringify({
    reviewers: tuples,
    head,
    ci,
    threadsTruncated,
    reviewDecision,
  });
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

// Whether this PR satisfies the `waitFor` filter THIS cycle (an
// absolute per-PR predicate; the per-PR fingerprint delta is checked
// separately by prChanged). `any` always satisfies, so any per-PR
// change wakes; the others gate on a per-PR state.
function waitForHolds(evaluation: PrEvaluation, opts: WatchOptions): boolean {
  switch (opts.waitFor) {
    case "any":
      return true;
    case "smart":
      return evaluation.actionable || evaluation.ready;
    case "all":
      return evaluation.allOnHead;
    case "quorum": {
      const nonPending = evaluation.reviewers.filter(
        (r) => r.verdict !== "pending",
      ).length;
      return nonPending >= opts.quorum;
    }
  }
}

// A PR is a wake source when it is `ready`, or when THIS PR's own
// fingerprint changed away from the caller's baseline AND its `waitFor`
// filter holds. Using the per-PR delta (not the batch delta) means a
// benign change to a sibling PR no longer spuriously wakes this one.
function prWakes(
  evaluation: PrEvaluation,
  changed: boolean,
  opts: WatchOptions,
): boolean {
  if (evaluation.ready) return true;
  return changed && waitForHolds(evaluation, opts);
}

// Human-readable reason a PR woke the multiplex, for the `changed`
// array. Keeps the caller from re-deriving why each PR is listed.
function wakeReason(
  evaluation: PrEvaluation,
  changed: boolean,
  opts: WatchOptions,
): string | null {
  if (evaluation.ready) return "ready";
  if (changed && waitForHolds(evaluation, opts)) {
    switch (opts.waitFor) {
      case "any":
        return "transition";
      case "smart":
        // Reachable only when not ready (ready returned above), so the
        // waitFor:smart filter held via `actionable`.
        return "actionable";
      case "all":
        return "all-on-head";
      case "quorum":
        return "quorum-reached";
    }
  }
  return null;
}

// The watch engine. Loops: query every PR, evaluate, and return as
// soon as ANY PR is `ready` or has a wake-worthy transition. Bails
// on abort between awaits, and stops at `maxWaitSeconds` with
// `timedOut: true`. A per-PR fetch error is captured on that item so
// one bad PR never kills the batch. Rate-limit / abuse-detection
// errors return a `rateLimited` snapshot rather than throwing out of
// the whole call.
export async function watchPrs(
  opts: WatchOptions,
  deps: WatchDeps,
): Promise<Output> {
  const { graphql, sleep, now, signal } = deps;
  const deadline = now() + opts.maxWaitSeconds * 1000;
  // Decode the caller's baseline once; every wake/changed decision is a
  // per-PR delta against it.
  const priorMap = decodeFingerprint(opts.sinceFingerprint);

  // Last good snapshot, so the abort / rate-limit paths can report
  // what we last saw rather than an empty payload. Empty before the
  // first cycle completes.
  let lastItems: OutputItem[] = opts.prs.map((pr) => emptyItem(pr, "not yet polled"));
  let lastEvaluations: Array<PrEvaluation | null> = opts.prs.map(() => null);

  while (true) {
    if (signal?.aborted) {
      return buildOutput(lastItems, lastEvaluations, opts, priorMap, true);
    }

    try {
      const cycle = await runCycle(graphql, opts);
      lastItems = cycle.items;
      lastEvaluations = cycle.evaluations;
    } catch (err) {
      if (
        err instanceof RateLimitExhaustedError ||
        err instanceof AbuseDetectionError
      ) {
        return buildRateLimited(lastItems, lastEvaluations, opts, priorMap, err, now());
      }
      throw err;
    }

    // Wake if any PR is ready, or THIS PR's own fingerprint changed away
    // from the caller's baseline and it satisfies the waitFor filter.
    const woke = lastEvaluations.some((ev, i) => {
      const item = lastItems[i];
      if (item === undefined) return false;
      const changed = prChanged(prKey(item), prComponent(item, ev), priorMap);
      // An error item has no evaluation, but an OK<->error transition (its
      // component changed) is still wake-worthy, so the agent learns a
      // watched PR started or stopped failing instead of waiting for timeout.
      if (ev === null) return changed;
      return prWakes(ev, changed, opts);
    });
    if (woke) return buildOutput(lastItems, lastEvaluations, opts, priorMap, false);

    // Out of budget: a single snapshot (maxWaitSeconds:0) lands here
    // immediately, and a longer block lands here once the deadline
    // passes. Both return timedOut so the caller re-invokes.
    if (now() >= deadline) {
      return buildOutput(lastItems, lastEvaluations, opts, priorMap, true);
    }

    if (signal?.aborted) {
      return buildOutput(lastItems, lastEvaluations, opts, priorMap, true);
    }
    await sleep(opts.pollSeconds * 1000);
    // Re-check the deadline after sleeping so a sleep that consumed
    // the remaining budget doesn't kick off another full cycle past
    // the documented ceiling.
    if (now() >= deadline) {
      return buildOutput(lastItems, lastEvaluations, opts, priorMap, true);
    }
  }
}

// Run one poll cycle: query + evaluate every PR. A per-PR fetch
// error is captured on that item (with a null evaluation) so the
// batch survives one bad PR.
async function runCycle(
  graphql: GraphqlClient,
  opts: WatchOptions,
): Promise<{ items: OutputItem[]; evaluations: Array<PrEvaluation | null> }> {
  const results = await Promise.all(
    opts.prs.map((pr) => fetchAndEvaluate(graphql, pr, opts)),
  );
  return {
    items: results.map((r) => r.item),
    evaluations: results.map((r) => r.evaluation),
  };
}

async function fetchAndEvaluate(
  graphql: GraphqlClient,
  pr: PrInput,
  opts: WatchOptions,
): Promise<{ item: OutputItem; evaluation: PrEvaluation | null }> {
  // Rate-limit / abuse errors must propagate so the engine can return
  // the dedicated rateLimited snapshot; every other fetch failure is
  // captured per-PR so one bad PR never kills the batch.
  let raw: RawPR;
  try {
    raw = await fetchRawPr(graphql, pr);
  } catch (err) {
    if (
      err instanceof RateLimitExhaustedError ||
      err instanceof AbuseDetectionError
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return { item: emptyItem(pr, message), evaluation: null };
  }
  const evaluation = evaluatePr(raw, opts);
  return { item: toItem(pr, evaluation), evaluation };
}

async function fetchRawPr(graphql: GraphqlClient, pr: PrInput): Promise<RawPR> {
  const coords = parseRepoSlug(pr.repo, "gh.pr_review_watch input");
  const data = await graphql<Response>("pr/review_watch", {
    owner: coords.owner,
    name: coords.name,
    number: pr.number,
  });
  if (!data.repository) {
    throw new Error(
      `mcp-github: gh.pr_review_watch: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  const raw = data.repository.pullRequest;
  if (!raw) {
    throw new Error(
      `mcp-github: gh.pr_review_watch: PR ${coords.owner}/${coords.name}#${pr.number} not found`,
    );
  }
  return raw;
}

function toItem(pr: PrInput, evaluation: PrEvaluation): OutputItem {
  return {
    repo: pr.repo,
    number: pr.number,
    head: evaluation.head,
    reviewers: evaluation.reviewers,
    actionable: evaluation.actionable,
    allOnHead: evaluation.allOnHead,
    ready: evaluation.ready,
    ci: evaluation.ci,
    reviewDecision: evaluation.reviewDecision,
    unresolvedByReviewer: evaluation.unresolvedByReviewer,
    threadsTruncated: evaluation.threadsTruncated,
  };
}

// Placeholder item for a PR whose fetch failed this cycle. The
// aggregates are reported as their inert values so the output stays
// schema-valid; the `error` field carries the failure reason.
function emptyItem(pr: PrInput, error: string): OutputItem {
  return {
    repo: pr.repo,
    number: pr.number,
    head: null,
    reviewers: [],
    actionable: false,
    allOnHead: false,
    ready: false,
    ci: null,
    reviewDecision: null,
    unresolvedByReviewer: {},
    threadsTruncated: false,
    error,
  };
}

// One PR's component within the encoded watch token: its per-PR
// fingerprint, or an error marker so a PR flipping between error and ok
// still registers as a change.
function prComponent(item: OutputItem, ev: PrEvaluation | null): string {
  if (ev) return ev.fingerprint;
  // Hash the error so the opaque token stays compact and never carries a
  // verbose upstream error string; the full message lives in items[*].error.
  const digest = createHash("sha1")
    .update(item.error ?? "unknown")
    .digest("hex")
    .slice(0, 8);
  return `error:${digest}`;
}

function prKey(item: { repo: string; number: number }): string {
  return `${item.repo}#${item.number}`;
}

// The returned `fingerprint` is an opaque token encoding the per-PR
// component map (base64 of a {`repo#number`: component} JSON object),
// so the caller can pass it back and the next call detects WHICH PR
// changed, not merely that the batch changed.
function encodeFingerprint(
  items: OutputItem[],
  evaluations: Array<PrEvaluation | null>,
): string {
  const map: Record<string, string> = {};
  items.forEach((item, i) => {
    map[prKey(item)] = prComponent(item, evaluations[i] ?? null);
  });
  return Buffer.from(JSON.stringify(map), "utf8").toString("base64");
}

// Decode a prior token into its per-PR component map. A missing or
// unparseable token yields null ("no baseline": only `ready` wakes,
// never a transition), so a first call or a corrupt token never
// produces spurious transition wakes.
function decodeFingerprint(
  token: string | null,
): Record<string, string> | null {
  if (token === null) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, "base64").toString("utf8"),
    );
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : null;
  } catch {
    return null;
  }
}

// Whether THIS PR's component moved away from the caller's baseline. A
// missing baseline (first call / undecodable token) is never a
// transition.
function prChanged(
  key: string,
  component: string,
  priorMap: Record<string, string> | null,
): boolean {
  return priorMap !== null && priorMap[key] !== component;
}

function buildOutput(
  items: OutputItem[],
  evaluations: Array<PrEvaluation | null>,
  opts: WatchOptions,
  priorMap: Record<string, string> | null,
  timedOut: boolean,
): Output {
  const fingerprint = encodeFingerprint(items, evaluations);
  const changed: Output["changed"] = [];
  for (let i = 0; i < items.length; i += 1) {
    const ev = evaluations[i] ?? null;
    const item = items[i];
    if (!item) continue;
    const changedSince = prChanged(prKey(item), prComponent(item, ev), priorMap);
    // Error items (null evaluation) surface with reason "error" when their
    // component changed; otherwise use the normal per-PR wake reason.
    const reason =
      ev === null
        ? changedSince
          ? "error"
          : null
        : wakeReason(ev, changedSince, opts);
    if (reason !== null) {
      changed.push({ repo: item.repo, number: item.number, reason });
    }
  }
  return {
    items,
    changed,
    fingerprint,
    timedOut,
  };
}

function buildRateLimited(
  items: OutputItem[],
  evaluations: Array<PrEvaluation | null>,
  opts: WatchOptions,
  priorMap: Record<string, string> | null,
  err: RateLimitExhaustedError | AbuseDetectionError,
  nowMs: number,
): Output {
  const base = buildOutput(items, evaluations, opts, priorMap, true);
  // RateLimitExhaustedError carries `resetAt` (epoch seconds);
  // AbuseDetectionError carries `retryAfterSeconds`. Surface a
  // forward-looking "seconds from now" figure for both so the caller
  // can back off uniformly. Use the injected clock (not Date.now) so the
  // engine stays deterministic under test.
  const retryAfter =
    err instanceof AbuseDetectionError
      ? err.retryAfterSeconds
      : Math.max(0, Math.round(err.resetAt - nowMs / 1000));
  return { ...base, rateLimited: true, retryAfter };
}

export function registerPRReviewWatchTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_review_watch", {
    description:
      "Blocking, multiplexed long-poll that watches 1..N PRs for " +
      "1..N reviewers and returns when ANY watched PR has a " +
      "wake-worthy transition, becomes `ready`, or the wait times " +
      "out. Per reviewer it computes a verdict on HEAD (pending / " +
      "needs-work / green) from `latestReviews` plus unresolved, " +
      "non-outdated review threads authored by that reviewer (NOT a " +
      "comment count, which misses Copilot's thread-based " +
      "findings). `ready` (strict done) means every reviewer is " +
      "green on HEAD, every requiredApprovals reviewer is APPROVED, " +
      "and (when requireCi) CI is SUCCESS. Wake is a TRANSITION away " +
      "from the prior `fingerprint`, filtered by `waitFor` " +
      "(any/smart/all/quorum), so it does not hot-loop. " +
      "`maxWaitSeconds` defaults to 25 to stay under the ~60s MCP " +
      "tool-call timeout common to clients; the agent re-invokes " +
      "passing the returned `fingerprint` back as `sinceFingerprint`. " +
      "Set `maxWaitSeconds: 0` for a single snapshot.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_review_watch input");
      // Parse every repo slug up front so a malformed slug fails the
      // whole call at the boundary rather than per-cycle.
      for (const pr of args.prs) {
        parseRepoSlug(pr.repo, "gh.pr_review_watch input");
      }
      const opts = normaliseOptions(args);
      // requiredApprovals that are not in the reviewer set would be
      // silently ignored (the verdict loop only covers `reviewers`),
      // letting `ready` go true without that approver. Reject it at the
      // boundary instead. Both sets are alias-mapped + lowercased.
      const reviewerSet = new Set(opts.reviewers);
      for (const login of opts.requiredApprovals) {
        if (!reviewerSet.has(login)) {
          throw new Error(
            `mcp-github: gh.pr_review_watch input: requiredApprovals must be a subset of reviewers ('${login}' is not in reviewers)`,
          );
        }
      }
      // A bot can never reach APPROVED, so requiring its approval would make
      // `ready` unreachable. Reject the known Copilot bot explicitly.
      if (opts.requiredApprovals.includes(COPILOT_LOGIN)) {
        throw new Error(
          `mcp-github: gh.pr_review_watch input: requiredApprovals cannot include '${COPILOT_LOGIN}' (a bot has no APPROVED state, so ready would be unreachable)`,
        );
      }
      // A quorum larger than the reviewer set can never be met (only `ready`
      // would ever wake), which is surprising. Fail fast.
      if (opts.waitFor === "quorum" && opts.quorum > opts.reviewers.length) {
        throw new Error(
          `mcp-github: gh.pr_review_watch input: quorum (${opts.quorum}) cannot exceed the reviewer count (${opts.reviewers.length})`,
        );
      }
      const deps: WatchDeps = {
        graphql,
        sleep: (ms) =>
          new Promise<void>((resolveSleep) => {
            setTimeout(resolveSleep, ms);
          }),
        now: () => Date.now(),
        // The MCP CallTool handler signature does not currently
        // expose an abort signal, so we omit it; watchPrs keeps
        // `signal` optional and simply never observes an abort here.
      };
      const out = await watchPrs(opts, deps);
      return validate<Output>(outputSchema, out, "gh.pr_review_watch output");
    },
  });
}

// Map the validated input onto the engine's normalised options:
// apply the copilot alias, default requiredApprovals to the human
// reviewers, and fill the numeric/enum defaults.
function normaliseOptions(args: Input): WatchOptions {
  const reviewers = dedupe(args.reviewers.map(mapReviewerAlias));
  const requiredApprovals =
    args.requiredApprovals !== undefined
      ? dedupe(args.requiredApprovals.map(mapReviewerAlias))
      : reviewers.filter((login) => !BOT_LOGINS.has(login));
  return {
    prs: args.prs,
    reviewers,
    requiredApprovals,
    waitFor: args.waitFor ?? "any",
    quorum: args.quorum ?? 1,
    sinceFingerprint: args.sinceFingerprint ?? null,
    pollSeconds: args.pollSeconds ?? POLL_SECONDS_DEFAULT,
    maxWaitSeconds: args.maxWaitSeconds ?? MAX_WAIT_SECONDS_DEFAULT,
    requireCi: args.requireCi ?? false,
  };
}

function mapReviewerAlias(login: string): string {
  // Canonicalise to lowercase (GitHub logins are case-insensitive) so
  // dedup, the requiredApprovals subset check, and verdict matching all
  // agree regardless of the case the caller passed.
  const lower = login.toLowerCase();
  return lower === COPILOT_ALIAS ? COPILOT_LOGIN : lower;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
