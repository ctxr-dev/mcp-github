// tests/unit/tools/pr/create.test.ts
//
// gh.pr_create: pin the repo-id lookup → mutation flow, the
// optional body/draft pass-through, and the input-validation
// boundary.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRCreateTool } from "../../../../src/tools/pr/create.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawPR, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_create") throw new Error(`unexpected: ${name}`);
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

test("gh.pr_create: looks up repo id, then runs CreatePullRequest", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/_repo-id": { repository: { id: "R_kwDO_repo" } },
    "pr/create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.repositoryId, "R_kwDO_repo");
      assert.equal(input.baseRefName, "main");
      assert.equal(input.headRefName, "feat/x");
      assert.equal(input.title, "Add x");
      assert.equal(input.body, "Body of x");
      assert.equal(input.draft, true);
      return { createPullRequest: { pullRequest: sampleRawPR } };
    },
  });
  const reg = captureRegistration();
  registerPRCreateTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    base: "main",
    head: "feat/x",
    title: "Add x",
    body: "Body of x",
    draft: true,
  })) as { number: number };
  assert.equal(out.number, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.queryName, "pr/_repo-id");
});

test("gh.pr_create: omits body and draft when not supplied", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_repo-id": { repository: { id: "R_kwDO_repo" } },
    "pr/create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal("body" in input, false);
      assert.equal("draft" in input, false);
      return { createPullRequest: { pullRequest: sampleRawPR } };
    },
  });
  const reg = captureRegistration();
  registerPRCreateTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    base: "main",
    head: "feat/x",
    title: "Minimal",
  });
});

test("gh.pr_create: throws when the repository is not found", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_repo-id": { repository: null },
    "pr/create": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerPRCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      base: "main",
      head: "feat/x",
      title: "x",
    }),
    /gh\.pr_create: repository 'owner\/repo' not found/,
  );
});

test("gh.pr_create: rejects empty title at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_repo-id": { repository: { id: "R_kwDO_repo" } },
    "pr/create": () => ({ createPullRequest: { pullRequest: sampleRawPR } }),
  });
  const reg = captureRegistration();
  registerPRCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      base: "main",
      head: "feat/x",
      title: "",
    }),
    /gh\.pr_create input/,
  );
});
