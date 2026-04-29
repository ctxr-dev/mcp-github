// tests/unit/tools/issue/create.test.ts
//
// gh.issue_create: pin the two-step name-resolution flow (repo
// context lookup → mutation) and the error paths for unknown
// labels / assignees, since those happen BEFORE the mutation runs
// and produce structured errors rather than GraphQL ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueCreateTool } from "../../../../src/tools/issue/create.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import {
  sampleRawIssue,
  sampleRepoContextResponse,
  stubGraphqlClient,
} from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_create") {
      throw new Error(`unexpected tool name: ${name}`);
    }
    entry = e;
  };
  return {
    register,
    get entry(): ToolEntry {
      if (!entry) throw new Error("handler was not registered");
      return entry;
    },
  };
}

test("gh.issue_create: resolves label names + assignee logins to IDs, then mutates", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/create": (vars: Record<string, unknown>) => {
      // Pin the mutation input shape — this is the contract that
      // matters for downstream consumers.
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.repositoryId, "R_kwDO_repo");
      assert.equal(input.title, "Hello");
      assert.equal(input.body, "World");
      assert.deepEqual(input.labelIds, ["LA_bug"]);
      assert.deepEqual(input.assigneeIds, ["U_alice"]);
      return { createIssue: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueCreateTool(reg.register, graphql);
  const out = await reg.entry.handler({
    repo: "owner/repo",
    title: "Hello",
    body: "World",
    labels: ["bug"],
    assignees: ["alice"],
  });
  assert.equal((out as { number: number }).number, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.queryName, "issue/_repo-context");
  assert.equal(calls[1]?.queryName, "issue/create");
});

test("gh.issue_create: throws on an unknown label name before mutating", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/create": () => {
      throw new Error("mutation must NOT run when label resolution fails");
    },
  });
  const reg = captureRegistration();
  registerIssueCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      title: "x",
      labels: ["bug", "imaginary"],
    }),
    /unknown label\(s\): imaginary/,
  );
  // We did the prep query but stopped before the mutation.
  assert.equal(calls.length, 1);
});

test("gh.issue_create: throws on an unknown assignee login before mutating", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/create": () => {
      throw new Error("mutation must NOT run when assignee resolution fails");
    },
  });
  const reg = captureRegistration();
  registerIssueCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      title: "x",
      assignees: ["alice", "ghost"],
    }),
    /unknown \/ non-assignable login\(s\): ghost/,
  );
});

test("gh.issue_create: throws when the repository is not found", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_repo-context": { repository: null },
    "issue/create": () => {
      throw new Error("mutation must not run");
    },
  });
  const reg = captureRegistration();
  registerIssueCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", title: "x" }),
    /repository 'owner\/repo' not found/,
  );
});

test("gh.issue_create: omits unset optional fields from the mutation input", async () => {
  // GraphQL serialises explicit `undefined` as `null`, which the
  // CreateIssueInput rejects for fields like `body`. Verify those
  // fields are absent from the variables when not supplied.
  const { graphql } = stubGraphqlClient({
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal("body" in input, false);
      assert.equal("labelIds" in input, false);
      assert.equal("assigneeIds" in input, false);
      return { createIssue: { issue: sampleRawIssue } };
    },
  });
  const reg = captureRegistration();
  registerIssueCreateTool(reg.register, graphql);
  await reg.entry.handler({ repo: "owner/repo", title: "minimal" });
});

test("gh.issue_create: rejects empty title at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_repo-context": sampleRepoContextResponse,
    "issue/create": () => ({ createIssue: { issue: sampleRawIssue } }),
  });
  const reg = captureRegistration();
  registerIssueCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", title: "" }),
    /gh\.issue_create input/,
  );
});
