// tests/unit/tools/issue/_shared.test.ts
//
// Pin the shared helpers used across the seven gh.issue_* tools.
// These cover the bits that aren't already exercised by the
// per-tool tests: the parseRepoSlug regex, summariseIssue's
// truncation warning, and the resolveLabelIds / resolveAssigneeIds
// error messages.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRepoSlug,
  resolveAssigneeIds,
  resolveLabelIds,
  summariseIssue,
  type RepoContext,
} from "../../../../src/tools/issue/_shared.ts";
import { sampleRawIssue } from "./_fixtures.ts";

test("parseRepoSlug: accepts canonical owner/name and rejects malformed input", () => {
  assert.deepEqual(parseRepoSlug("owner/repo", "test"), {
    owner: "owner",
    name: "repo",
  });
  assert.throws(() => parseRepoSlug("no-slash", "test"), /test: invalid repo/);
  assert.throws(() => parseRepoSlug("a/b/c", "test"), /test: invalid repo/);
  assert.throws(() => parseRepoSlug(" owner/repo", "test"), /test: invalid repo/);
});

test("summariseIssue: warns when labels are truncated, lists what was returned", () => {
  // Truncation is non-fatal — issues with > 100 labels are
  // vanishingly rare in practice, so we surface a stderr-style
  // warning rather than failing or paginating. Pin both the
  // warning content and the fact that the visible labels are
  // still passed through.
  const truncated = {
    ...sampleRawIssue,
    labels: {
      pageInfo: { hasNextPage: true },
      nodes: [{ name: "bug" }, { name: "p1" }],
    },
  };
  const warns: string[] = [];
  const summary = summariseIssue(truncated, (m) => warns.push(m));
  assert.deepEqual(summary.labels, ["bug", "p1"]);
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /more than 100 labels/);
  assert.match(warns[0] ?? "", /truncated to the first page/);
});

test("summariseIssue: warns when assignees are truncated", () => {
  const truncated = {
    ...sampleRawIssue,
    assignees: {
      pageInfo: { hasNextPage: true },
      nodes: [{ login: "alice" }],
    },
  };
  const warns: string[] = [];
  summariseIssue(truncated, (m) => warns.push(m));
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /more than 100 assignees/);
});

test("summariseIssue: silent on the common, not-truncated case", () => {
  const warns: string[] = [];
  summariseIssue(sampleRawIssue, (m) => warns.push(m));
  assert.equal(warns.length, 0);
});

const sampleContext: RepoContext = {
  repositoryId: "R_kwDO_repo",
  labelsByName: new Map([
    ["bug", "LA_bug"],
    ["p1", "LA_p1"],
  ]),
  usersByLogin: new Map([
    ["alice", "U_alice"],
    ["bob", "U_bob"],
  ]),
};

test("resolveLabelIds: lists every unknown label, not just the first", () => {
  // The per-tool tests cover the happy path + single-miss case;
  // this pins the all-misses-aggregated contract so a caller doesn't
  // have to retry-and-discover one missing label at a time.
  assert.throws(
    () => resolveLabelIds(sampleContext, ["bug", "ghost", "phantom"], "test"),
    /unknown label\(s\): ghost, phantom/,
  );
});

test("resolveAssigneeIds: lists every unknown login, not just the first", () => {
  assert.throws(
    () =>
      resolveAssigneeIds(
        sampleContext,
        ["alice", "ghost", "phantom"],
        "test",
      ),
    /unknown \/ non-assignable login\(s\): ghost, phantom/,
  );
});
