// tests/unit/tools/pr/edit.test.ts
//
// gh.pr_edit: pin the field-edit pass-through plus the
// draft-toggle two-mutation flow (the underlying GraphQL
// surfaces draft state via two distinct mutations rather than
// UpdatePullRequestInput).

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPREditTool } from "../../../../src/tools/pr/edit.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawPR, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_edit") throw new Error(`unexpected: ${name}`);
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

test("gh.pr_edit: title/body/base-only edits run a single UpdatePullRequest", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/edit": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.pullRequestId, "PR_target");
      assert.equal(input.title, "New title");
      assert.equal(input.body, "New body");
      assert.equal(input.baseRefName, "develop");
      assert.equal("draft" in input, false);
      return { updatePullRequest: { pullRequest: sampleRawPR } };
    },
  });
  const reg = captureRegistration();
  registerPREditTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    title: "New title",
    body: "New body",
    base: "develop",
  });
  // Lookup + edit; no draft-toggle.
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.queryName, "pr/edit");
});

test("gh.pr_edit: draft: true routes through convertPullRequestToDraft", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_to-draft": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.pullRequestId, "PR_target");
      return {
        convertPullRequestToDraft: {
          pullRequest: { ...sampleRawPR, isDraft: true },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerPREditTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    draft: true,
  })) as { draft: boolean };
  assert.equal(out.draft, true);
  // Draft-only edit: lookup + toggle, no pr/edit call.
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["pr/_pr-lookup", "pr/_to-draft"],
  );
});

test("gh.pr_edit: draft: false routes through markPullRequestReadyForReview", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_ready-for-review": {
      markPullRequestReadyForReview: {
        pullRequest: { ...sampleRawPR, isDraft: false },
      },
    },
  });
  const reg = captureRegistration();
  registerPREditTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    draft: false,
  })) as { draft: boolean };
  assert.equal(out.draft, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.queryName, "pr/_ready-for-review");
});

test("gh.pr_edit: title + draft true runs both edit AND draft-toggle", async () => {
  // The composite case: caller wants to edit the title AND mark
  // as draft. We run pr/edit first (so the title change persists
  // even if the draft-toggle later fails), then the toggle. The
  // returned PR is the one from the toggle response — its title
  // already reflects the prior edit.
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/edit": { updatePullRequest: { pullRequest: sampleRawPR } },
    "pr/_to-draft": {
      convertPullRequestToDraft: {
        pullRequest: { ...sampleRawPR, title: "New title", isDraft: true },
      },
    },
  });
  const reg = captureRegistration();
  registerPREditTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 7,
    title: "New title",
    draft: true,
  })) as { title: string; draft: boolean };
  assert.equal(out.title, "New title");
  assert.equal(out.draft, true);
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["pr/_pr-lookup", "pr/edit", "pr/_to-draft"],
  );
});

test("gh.pr_edit: throws when the PR cannot be found", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: null } },
  });
  const reg = captureRegistration();
  registerPREditTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 99, title: "x" }),
    /PR owner\/repo#99 not found/,
  );
});
