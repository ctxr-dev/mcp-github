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

// Sleeper injection-point lets the unit tests advance fake time
// without an actual setTimeout. Production path uses the default;
// tests override via the exported `_setSleeper`.
type Sleeper = (ms: number) => Promise<void>;
let sleeper: Sleeper = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function _setSleeper(s: Sleeper | null): void {
  sleeper = s ?? ((ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }));
}

// Clock injection-point for the wall-clock budget. Defaulting to
// `Date.now` keeps prod fast; tests override to advance time
// deterministically alongside the sleeper.
type Clock = () => number;
let clock: Clock = () => Date.now();

export function _setClock(c: Clock | null): void {
  clock = c ?? (() => Date.now());
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
  const first = await fetchOnce(graphql, coords, args.number);
  if (
    args.wait_for_mergeable === undefined ||
    first.mergeable !== "UNKNOWN"
  ) {
    return first;
  }
  const timeoutMs =
    (args.wait_for_mergeable.timeout_seconds ??
      WAIT_TIMEOUT_DEFAULT_SECONDS) * 1000;
  const intervalMs =
    (args.wait_for_mergeable.poll_interval_seconds ??
      POLL_INTERVAL_DEFAULT_SECONDS) * 1000;
  const deadline = clock() + timeoutMs;
  let last = first;
  while (clock() < deadline) {
    // Sleep BEFORE re-querying so we don't hammer the API on the
    // first iteration — the initial fetch already used the
    // current state. Cap the sleep at the remaining budget so a
    // 30s timeout with a 25s interval doesn't wait the full 25s
    // past the deadline.
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await sleeper(Math.min(intervalMs, remaining));
    // Re-check the deadline AFTER sleeping. The sleep may have
    // consumed the entire remaining budget; without this guard
    // we'd kick off another GraphQL fetch (which itself takes
    // wall-clock time) after the budget is gone, exceeding the
    // documented `timeout_seconds` ceiling.
    if (clock() >= deadline) break;
    last = await fetchOnce(graphql, coords, args.number);
    if (last.mergeable !== "UNKNOWN") return last;
  }
  // Timeout: return the last payload as-is. mergeable stays
  // UNKNOWN; caller decides whether to retry the whole tool call.
  return last;
}

async function fetchOnce(
  graphql: GraphqlClient,
  coords: { owner: string; name: string },
  number: number,
): Promise<PRSummary> {
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
  return summarisePR(pr);
}
