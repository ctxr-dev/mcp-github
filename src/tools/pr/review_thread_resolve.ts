// src/tools/pr/review_thread_resolve.ts
//
// `gh.pr_review_thread_resolve` — marks a PR review thread as
// resolved via GraphQL's `resolveReviewThread` mutation. One
// thread per call by design: the methodology memory rule
// `feedback_avoid_chained_gh_calls.md` says never chain these
// mutations in a single shell because a single bad ID silently
// kills the rest of the chain. Callers that need to resolve
// many threads loop client-side over `gh.pr_review_threads_list`
// output.
//
// The mutation returns the thread's post-mutation state
// (`isResolved`) so the caller can confirm the resolve actually
// took effect — if a thread is already resolved, GitHub still
// returns `isResolved: true` with no error, which is the
// idempotent property the methodology's "resolve all addressed
// threads in the same push" rule relies on.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";

const inputSchema = {
  type: "object",
  required: ["thread_id"],
  properties: {
    thread_id: {
      type: "string",
      minLength: 1,
      description:
        "Review thread node ID, as returned by " +
        "`gh.pr_review_threads_list` in each thread's `id` field.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["thread_id", "is_resolved"],
  properties: {
    thread_id: { type: "string" },
    is_resolved: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  thread_id: string;
}

interface Output {
  thread_id: string;
  is_resolved: boolean;
}

interface Response {
  resolveReviewThread: {
    thread: { id: string; isResolved: boolean };
  };
}

export function registerPRReviewThreadResolveTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_review_thread_resolve", {
    description:
      "Mark ONE PR review thread as resolved via GraphQL's " +
      "`resolveReviewThread` mutation. Idempotent: re-running on " +
      "an already-resolved thread returns `is_resolved: true` " +
      "without error. ONE thread per call by design — callers loop " +
      "client-side over `gh.pr_review_threads_list` output rather " +
      "than chaining IDs, because a single bad ID in a chain " +
      "silently kills the rest.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.pr_review_thread_resolve input",
      );
      const data = await graphql<Response>("pr/review_thread_resolve", {
        input: { threadId: args.thread_id },
      });
      const out: Output = {
        thread_id: data.resolveReviewThread.thread.id,
        is_resolved: data.resolveReviewThread.thread.isResolved,
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.pr_review_thread_resolve output",
      );
    },
  });
}
