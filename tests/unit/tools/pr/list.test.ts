// tests/unit/tools/pr/list.test.ts
//
// gh.pr_list: pin the default-state filter, the head/base/author
// filters, and the cross-repo author client-side post-filter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPRListTool } from "../../../../src/tools/pr/list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawPR, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_list") throw new Error(`unexpected: ${name}`);
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

test("gh.pr_list: defaults to OPEN, returns one page with pageInfo", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/list": {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [sampleRawPR],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerPRListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo" })) as {
    items: Array<{ number: number }>;
    hasNextPage: boolean;
    endCursor: string | null;
  };
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.number, 7);
  assert.deepEqual(calls[0]?.vars.states, ["OPEN"]);
  assert.equal(calls[0]?.vars.headRefName, null);
  assert.equal(calls[0]?.vars.baseRefName, null);
});

test("gh.pr_list: state=ALL passes a null states filter to GraphQL", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/list": {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerPRListTool(reg.register, graphql);
  await reg.entry.handler({ repo: "owner/repo", state: "ALL" });
  assert.equal(calls[0]?.vars.states, null);
});

test("gh.pr_list: head + base filters pass through to GraphQL vars", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/list": {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerPRListTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    head: "feat/x",
    base: "main",
  });
  assert.equal(calls[0]?.vars.headRefName, "feat/x");
  assert.equal(calls[0]?.vars.baseRefName, "main");
});

test("gh.pr_list: strips `owner:` prefix from head before forwarding to GraphQL", async () => {
  // `gh pr list --head owner:branch` is the canonical fork-PR
  // shape, but GraphQL's headRefName filter is the bare branch
  // name. Without stripping, fork PRs would silently match
  // nothing.
  const { graphql, calls } = stubGraphqlClient({
    "pr/list": {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerPRListTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    head: "fork-owner:feat/x",
  });
  assert.equal(calls[0]?.vars.headRefName, "feat/x");
});

test("gh.pr_list: author filter is post-filtered client-side", async () => {
  const others = {
    ...sampleRawPR,
    number: 8,
    author: { login: "carol" },
  };
  const { graphql } = stubGraphqlClient({
    "pr/list": {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [sampleRawPR, others],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerPRListTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    author: "bob",
  })) as { items: Array<{ number: number; author: string | null }> };
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.number, 7);
});

test("gh.pr_list: throws when the repository is not found", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/list": { repository: null },
  });
  const reg = captureRegistration();
  registerPRListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo" }),
    /repository 'owner\/repo' not found/,
  );
});
