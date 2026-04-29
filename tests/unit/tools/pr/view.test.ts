// tests/unit/tools/pr/view.test.ts
//
// gh.pr_view: pin the canonical PRSummary shape (heavier than
// IssueSummary because it rolls in reviews + review-comment count
// + status-check rollup) plus the repo-vs-PR error distinction.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRViewTool } from "../../../../src/tools/pr/view.ts";
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
    review_comments_count: number;
    status_checks_state: string | null;
    status_checks: Array<{ context: string; state: string }>;
    reviews: Array<{ author: string | null; state: string }>;
  };
  assert.equal(out.number, 7);
  assert.equal(out.base, "main");
  assert.equal(out.head, "feat/x");
  // 3 + 0 = 3 review-comments across two threads.
  assert.equal(out.review_comments_count, 3);
  assert.equal(out.status_checks_state, "SUCCESS");
  assert.deepEqual(
    out.status_checks.map((c) => c.context),
    ["ci/build", "ci/legacy"],
  );
  assert.deepEqual(out.reviews, [{ author: "carol", state: "APPROVED" }]);
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
