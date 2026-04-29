// tests/unit/tools/pr/merge.test.ts
//
// gh.pr_merge: pin the method mapping (merge|squash|rebase →
// MERGE|SQUASH|REBASE), the commit_title/commit_message
// pass-through (only for merge / squash, not rebase), and the
// happy-path output shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRMergeTool } from "../../../../src/tools/pr/merge.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_merge") throw new Error(`unexpected: ${name}`);
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

const sampleMerged = {
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  merged: true,
  mergeCommit: { oid: "deadbeef" },
};

test("gh.pr_merge: method=merge maps to MERGE and passes commit_title/message", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_7" } } },
    "pr/merge": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.pullRequestId, "PR_7");
      assert.equal(input.mergeMethod, "MERGE");
      assert.equal(input.commitHeadline, "feat: subject");
      assert.equal(input.commitBody, "Body of the commit");
      return { mergePullRequest: { pullRequest: sampleMerged } };
    },
  });
  const reg = captureRegistration();
  registerPRMergeTool(reg.register, graphql);
  const out = await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    method: "merge",
    commit_title: "feat: subject",
    commit_message: "Body of the commit",
  });
  assert.deepEqual(out, {
    merged: true,
    sha: "deadbeef",
    url: "https://github.com/owner/repo/pull/7",
    number: 7,
  });
});

test("gh.pr_merge: method=squash maps to SQUASH", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_7" } } },
    "pr/merge": (vars: Record<string, unknown>) => {
      assert.equal(
        (vars.input as Record<string, unknown>).mergeMethod,
        "SQUASH",
      );
      return { mergePullRequest: { pullRequest: sampleMerged } };
    },
  });
  const reg = captureRegistration();
  registerPRMergeTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    method: "squash",
  });
});

test("gh.pr_merge: method=rebase silently drops commit_title/commit_message", async () => {
  // GitHub rejects MergePullRequest with REBASE + commitHeadline.
  // The tool spec lets the caller pass them anyway (matching `gh
  // pr merge`'s ergonomics) but we don't forward them — the
  // rebased commit subjects come from the source branch, not from
  // a merge-commit override that doesn't exist.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_7" } } },
    "pr/merge": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.mergeMethod, "REBASE");
      assert.equal("commitHeadline" in input, false);
      assert.equal("commitBody" in input, false);
      return {
        mergePullRequest: {
          pullRequest: { ...sampleMerged, mergeCommit: null },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPRMergeTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    method: "rebase",
    commit_title: "ignored on rebase",
    commit_message: "also ignored",
  })) as { sha: string | null };
  assert.equal(out.sha, null);
});

test("gh.pr_merge: rejects unknown method at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_7" } } },
    "pr/merge": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerPRMergeTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 7,
      method: "auto",
    }),
    /gh\.pr_merge input/,
  );
});
