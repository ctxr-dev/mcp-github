// src/tools/pr/view.ts
//
// `gh.pr_view` — fetches a PR with reviews + review-comment count
// + status-checks rolled in. The output shape (`PRSummary`) is
// shared with create/edit (and list, which returns an array of
// these), so consumers see the same fields regardless of how
// they got the PR payload. gh.pr_merge has its own smaller
// `{merged, sha, url, number}` shape because the merge mutation
// only guarantees those fields and a full re-fetch would be
// wasted work.
//
// Optional `wait_for_mergeable` polling (A9): GitHub returns
// `mergeable: UNKNOWN` for a short window after a push while it
// computes the mergeability state in the background. The
// methodology's PR loop needs the resolved value to decide
// whether to merge or ask the user to rebase; rather than making
// the agent poll, this tool owns the cadence — when
// `wait_for_mergeable` is supplied, it re-runs the query at
// `poll_interval_seconds` intervals until `mergeable !=
// "UNKNOWN"` or the timeout fires. On timeout the last payload
// is returned as-is (still `UNKNOWN`); the caller decides whether
// to retry the whole tool call or proceed.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type PRSummary,
  type RawPR,
  parseRepoSlug,
  prSummarySchema,
  repoSlugSchema,
  summarisePR,
} from "./_shared.js";

// The polling path holds onto the RawPR and summarises only
// once at the very end (see fetchWithOptionalWait below), so the
// truncation-warning side effect fires exactly once per tool
// call rather than once per retry. Matches the methodology's
// "agent gets one signal per op" expectation.

const WAIT_TIMEOUT_DEFAULT_SECONDS = 30;
const WAIT_TIMEOUT_MAX_SECONDS = 120;
const POLL_INTERVAL_DEFAULT_SECONDS = 5;
const POLL_INTERVAL_MIN_SECONDS = 1;
const POLL_INTERVAL_MAX_SECONDS = 30;

const waitForMergeableSchema = {
  type: "object",
  properties: {
    timeout_seconds: {
      type: "integer",
      minimum: 1,
      maximum: WAIT_TIMEOUT_MAX_SECONDS,
      description:
        `Max wall-clock seconds to spend polling (default ${WAIT_TIMEOUT_DEFAULT_SECONDS}, max ${WAIT_TIMEOUT_MAX_SECONDS}).`,
    },
    poll_interval_seconds: {
      type: "integer",
      minimum: POLL_INTERVAL_MIN_SECONDS,
      maximum: POLL_INTERVAL_MAX_SECONDS,
      description:
        `Seconds between retries (default ${POLL_INTERVAL_DEFAULT_SECONDS}, min ${POLL_INTERVAL_MIN_SECONDS}, max ${POLL_INTERVAL_MAX_SECONDS}).`,
    },
  },
  additionalProperties: false,
} as const;

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    wait_for_mergeable: waitForMergeableSchema,
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  wait_for_mergeable?: {
    timeout_seconds?: number;
    poll_interval_seconds?: number;
  };
}

interface Response {
  repository: { pullRequest: RawPR | null } | null;
}

// Sleeper + clock injection-points let the unit tests advance
// fake time without real setTimeout / Date.now. Both have a
// single source-of-truth default (defined once, referenced from
// both the initial binding and the reset-to-null path of the
// `_set*` hook) and both `let` bindings start at the default.
// The `_set*` hooks below are MODULE-INTERNAL TEST HOOKS — the
// `_` prefix follows the same convention used by other tools
// (`_readReviewRequestsOff`, `_resetQueryCache`); they are not
// part of the package's public API and the test file uses them
// inside `try { ... } finally { _setX(null); }` blocks so each
// test restores the defaults before the next runs.
//
// Concurrency note: Node's `--test` runs files concurrently but
// tests WITHIN a file serially, which matches the assumption
// these module-level hooks rely on. If we ever fan tests out
// to parallel `test.concurrent(...)`, switch to closure-scoped
// dependency injection via `registerPRViewTool`.
type Sleeper = (ms: number) => Promise<void>;
type Clock = () => number;

const defaultSleeper: Sleeper = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const defaultClock: Clock = () => Date.now();

let sleeper: Sleeper = defaultSleeper;
let clock: Clock = defaultClock;

/** @internal — test-only hook; do not import from outside tests/. */
export function _setSleeper(s: Sleeper | null): void {
  sleeper = s ?? defaultSleeper;
}

/** @internal — test-only hook; do not import from outside tests/. */
export function _setClock(c: Clock | null): void {
  clock = c ?? defaultClock;
}

export function registerPRViewTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_view", {
    description:
      "Fetch a PR with reviews, review-comment count, and " +
      "status-checks summary. Returns the canonical PRSummary " +
      "shape used by every PR tool that produces a full payload. " +
      "Optional `wait_for_mergeable`: re-runs the query at " +
      "`poll_interval_seconds` intervals until `mergeable != UNKNOWN` " +
      "or `timeout_seconds` elapses; on timeout the last payload " +
      "is returned regardless (mergeable still UNKNOWN), so the " +
      "caller has a final answer rather than a hang.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_view input");
      const coords = parseRepoSlug(args.repo, "gh.pr_view input");
      const summary = await fetchWithOptionalWait(graphql, coords, args);
      return validate<PRSummary>(prSummarySchema, summary, "gh.pr_view output");
    },
  });
}

async function fetchWithOptionalWait(
  graphql: GraphqlClient,
  coords: { owner: string; name: string },
  args: Input,
): Promise<PRSummary> {
  // Fast path: no polling. Summarise with the default warn so
  // truncation hints land normally.
  if (args.wait_for_mergeable === undefined) {
    const raw = await fetchRawOnce(graphql, coords, args.number);
    return summarisePR(raw);
  }
  // Polling path: every intermediate fetch suppresses warnings
  // (otherwise the same truncation message would spam stderr
  // once per retry); the FINAL returned payload re-summarises
  // with the default warn, so the user sees the truncation hint
  // exactly once per tool call.
  const firstRaw = await fetchRawOnce(graphql, coords, args.number);
  if (firstRaw.mergeable !== "UNKNOWN") {
    return summarisePR(firstRaw);
  }
  const timeoutMs =
    (args.wait_for_mergeable.timeout_seconds ??
      WAIT_TIMEOUT_DEFAULT_SECONDS) * 1000;
  const intervalMs =
    (args.wait_for_mergeable.poll_interval_seconds ??
      POLL_INTERVAL_DEFAULT_SECONDS) * 1000;
  const deadline = clock() + timeoutMs;
  let lastRaw = firstRaw;
  // Capture `now` once per iteration so we only call `clock()`
  // a single time per pass — easier to reason about under
  // injected clocks, and consistent across the three comparisons
  // the loop body does.
  for (let now = clock(); now < deadline; now = clock()) {
    // Sleep BEFORE re-querying so we don't hammer the API on the
    // first iteration — the initial fetch already used the
    // current state. Cap the sleep at the remaining budget so a
    // 30s timeout with a 25s interval doesn't wait the full 25s
    // past the deadline.
    const remaining = deadline - now;
    if (remaining <= 0) break;
    await sleeper(Math.min(intervalMs, remaining));
    // Re-check the deadline AFTER sleeping. The sleep may have
    // consumed the entire remaining budget; without this guard
    // we'd kick off another GraphQL fetch (which itself takes
    // wall-clock time) after the budget is gone, exceeding the
    // documented `timeout_seconds` ceiling.
    if (clock() >= deadline) break;
    lastRaw = await fetchRawOnce(graphql, coords, args.number);
    if (lastRaw.mergeable !== "UNKNOWN") return summarisePR(lastRaw);
  }
  // Timeout: summarise the last payload (mergeable stays
  // UNKNOWN). Use the default warn so any truncation hint fires
  // exactly once — the intermediate retries suppressed it.
  // Reset the per-payload warn by re-summarising via a fresh
  // call rather than re-using a stale summary; cheaper than
  // tracking warn state.
  return summarisePR(lastRaw);
}

async function fetchRawOnce(
  graphql: GraphqlClient,
  coords: { owner: string; name: string },
  number: number,
): Promise<RawPR> {
  const data = await graphql<Response>("pr/view", {
    owner: coords.owner,
    name: coords.name,
    number,
  });
  // Distinguish "repo missing / no access" from "PR missing" so
  // a typo in the slug doesn't surface as a misleading
  // "PR not found" message.
  if (!data.repository) {
    throw new Error(
      `mcp-github: gh.pr_view: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
    );
  }
  const pr = data.repository.pullRequest;
  if (!pr) {
    throw new Error(
      `mcp-github: gh.pr_view: PR ${coords.owner}/${coords.name}#${number} not found`,
    );
  }
  // Return the raw payload; summarisePR runs once at the end of
  // fetchWithOptionalWait so the truncation-warning side effect
  // fires exactly once per tool call (even when polling).
  return pr;
}
