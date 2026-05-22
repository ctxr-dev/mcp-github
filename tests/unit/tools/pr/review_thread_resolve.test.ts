// tests/unit/tools/pr/review_thread_resolve.test.ts
//
// gh.pr_review_thread_resolve: pin the input→mutation mapping,
// the idempotent "already resolved" pass-through, and the
// input-schema rejection of empty / missing thread_id.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRReviewThreadResolveTool } from "../../../../src/tools/pr/review_thread_resolve.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_review_thread_resolve") {
      throw new Error(`unexpected: ${name}`);
    }
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

test("gh.pr_review_thread_resolve: passes thread_id through as threadId on the mutation", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/review_thread_resolve": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.threadId, "RT_abc");
      return {
        resolveReviewThread: {
          thread: { id: "RT_abc", isResolved: true },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPRReviewThreadResolveTool(reg.register, graphql);
  const out = (await reg.entry.handler({ thread_id: "RT_abc" })) as {
    thread_id: string;
    is_resolved: boolean;
  };
  assert.deepEqual(out, { thread_id: "RT_abc", is_resolved: true });
  assert.equal(calls.length, 1);
});

test("gh.pr_review_thread_resolve: idempotent — already-resolved thread still returns is_resolved: true", async () => {
  const { graphql } = stubGraphqlClient({
    // GitHub does not error on a no-op resolve; it returns the
    // thread with isResolved: true regardless of prior state.
    "pr/review_thread_resolve": () => ({
      resolveReviewThread: {
        thread: { id: "RT_already", isResolved: true },
      },
    }),
  });
  const reg = captureRegistration();
  registerPRReviewThreadResolveTool(reg.register, graphql);
  const out = (await reg.entry.handler({ thread_id: "RT_already" })) as {
    is_resolved: boolean;
  };
  assert.equal(out.is_resolved, true);
});

test("gh.pr_review_thread_resolve: rejects empty thread_id at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewThreadResolveTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ thread_id: "" }),
    /gh\.pr_review_thread_resolve input/,
  );
});

test("gh.pr_review_thread_resolve: rejects missing thread_id at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewThreadResolveTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({}),
    /gh\.pr_review_thread_resolve input/,
  );
});

test("gh.pr_review_thread_resolve: rejects unknown extra properties at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRReviewThreadResolveTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ thread_id: "RT_x", repo: "owner/repo" }),
    /gh\.pr_review_thread_resolve input/,
  );
});
