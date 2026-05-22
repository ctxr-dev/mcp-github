// tests/unit/tools/issue/add_sub_issue.test.ts
//
// gh.issue_add_sub_issue: pin the lazy-node-id resolution paths
// (raw node_id passes through; (repo, number) triggers a lookup),
// the parallel-lookup behaviour, the mutation input shape, and
// the input-schema's oneOf rejection of mixed shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerIssueAddSubIssueTool } from "../../../../src/tools/issue/add_sub_issue.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.issue_add_sub_issue") throw new Error(`unexpected: ${name}`);
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

test("gh.issue_add_sub_issue: (repo, number) on both sides → two lookups + one mutation", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": (vars: Record<string, unknown>) => {
      // Two lookups: tell them apart by issue number.
      if (vars.number === 1) {
        return { repository: { issue: { id: "I_parent" } } };
      }
      if (vars.number === 2) {
        return { repository: { issue: { id: "I_child" } } };
      }
      throw new Error(`unexpected lookup number: ${String(vars.number)}`);
    },
    "issue/add_sub_issue": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.issueId, "I_parent");
      assert.equal(input.subIssueId, "I_child");
      return {
        addSubIssue: {
          issue: { id: "I_parent", number: 1 },
          subIssue: { id: "I_child", number: 2 },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    parent: { repo: "owner/repo", number: 1 },
    child: { repo: "owner/repo", number: 2 },
  })) as { parent: { number: number; node_id: string }; child: { number: number; node_id: string } };
  assert.deepEqual(out, {
    parent: { number: 1, node_id: "I_parent" },
    child: { number: 2, node_id: "I_child" },
  });
  // Two lookups + one mutation. We don't pin order between the
  // two lookups because they run in parallel via Promise.all.
  assert.equal(calls.length, 3);
  const queryNames = calls.map((c) => c.queryName).sort();
  assert.deepEqual(queryNames, [
    "issue/_issue-lookup",
    "issue/_issue-lookup",
    "issue/add_sub_issue",
  ]);
});

test("gh.issue_add_sub_issue: node_id on both sides → zero lookups, one mutation", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/add_sub_issue": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.issueId, "I_pre_parent");
      assert.equal(input.subIssueId, "I_pre_child");
      return {
        addSubIssue: {
          issue: { id: "I_pre_parent", number: 10 },
          subIssue: { id: "I_pre_child", number: 11 },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    parent: { node_id: "I_pre_parent" },
    child: { node_id: "I_pre_child" },
  })) as { parent: { number: number }; child: { number: number } };
  assert.equal(out.parent.number, 10);
  assert.equal(out.child.number, 11);
  // Zero lookups: both IDs were supplied.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.queryName, "issue/add_sub_issue");
});

test("gh.issue_add_sub_issue: mixed shapes — node_id on parent, (repo, number) on child", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "issue/_issue-lookup": (_vars: Record<string, unknown>) =>
      ({ repository: { issue: { id: "I_child" } } }),
    "issue/add_sub_issue": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.issueId, "I_parent_pre");
      assert.equal(input.subIssueId, "I_child");
      return {
        addSubIssue: {
          issue: { id: "I_parent_pre", number: 1 },
          subIssue: { id: "I_child", number: 2 },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  await reg.entry.handler({
    parent: { node_id: "I_parent_pre" },
    child: { repo: "owner/repo", number: 2 },
  });
  // One lookup (child only) + one mutation.
  assert.equal(calls.length, 2);
});

test("gh.issue_add_sub_issue: rejects mixed (node_id + repo) at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": () => {
      throw new Error("must not run");
    },
    "issue/add_sub_issue": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      parent: { node_id: "I_x", repo: "owner/repo", number: 1 },
      child: { node_id: "I_y" },
    }),
    /gh\.issue_add_sub_issue input/,
  );
});

test("gh.issue_add_sub_issue: rejects an empty side at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      parent: {},
      child: { node_id: "I_y" },
    }),
    /gh\.issue_add_sub_issue input/,
  );
});

test("gh.issue_add_sub_issue: lookup error on parent surfaces with the parent side labelled", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": (vars: Record<string, unknown>) => {
      // Repo missing on the parent lookup, child lookup never
      // returns because Promise.all rejects on first failure. We
      // mock both anyway because graphql() is called for both.
      if (vars.number === 1) {
        return { repository: null };
      }
      return { repository: { issue: { id: "I_child" } } };
    },
  });
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      parent: { repo: "owner/repo", number: 1 },
      child: { repo: "owner/repo", number: 2 },
    }),
    /gh\.issue_add_sub_issue parent/,
  );
});

test("gh.issue_add_sub_issue: lookup error on child surfaces with the child side labelled", async () => {
  const { graphql } = stubGraphqlClient({
    "issue/_issue-lookup": (vars: Record<string, unknown>) => {
      if (vars.number === 1) {
        return { repository: { issue: { id: "I_parent" } } };
      }
      return { repository: { issue: null } };
    },
  });
  const reg = captureRegistration();
  registerIssueAddSubIssueTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      parent: { repo: "owner/repo", number: 1 },
      child: { repo: "owner/repo", number: 99 },
    }),
    /gh\.issue_add_sub_issue child/,
  );
});
