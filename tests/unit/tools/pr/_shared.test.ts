// tests/unit/tools/pr/_shared.test.ts
//
// Pin the truncation-warning paths in `summarisePR()`. The issue
// domain has the analogous test at
// `tests/unit/tools/issue/_shared.test.ts`; we mirror the
// coverage here so each truncation flag (labels, assignees,
// reviews, reviewThreads, status-check contexts) surfaces a
// stderr-style warning rather than silently emitting a partial
// payload.

import { test } from "node:test";
import assert from "node:assert/strict";

import { summarisePR } from "../../../../src/tools/pr/_shared.ts";
import { sampleRawPR } from "./_fixtures.ts";

test("summarisePR: silent on the common, not-truncated case", () => {
  const warns: string[] = [];
  summarisePR(sampleRawPR, (m) => warns.push(m));
  assert.equal(warns.length, 0);
});

test("summarisePR: warns when labels are truncated", () => {
  const truncated = {
    ...sampleRawPR,
    labels: { ...sampleRawPR.labels, pageInfo: { hasNextPage: true } },
  };
  const warns: string[] = [];
  summarisePR(truncated, (m) => warns.push(m));
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /labels \(>100\)/);
});

test("summarisePR: warns when assignees are truncated", () => {
  const truncated = {
    ...sampleRawPR,
    assignees: { ...sampleRawPR.assignees, pageInfo: { hasNextPage: true } },
  };
  const warns: string[] = [];
  summarisePR(truncated, (m) => warns.push(m));
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /assignees \(>100\)/);
});

test("summarisePR: warns when reviews are truncated", () => {
  const truncated = {
    ...sampleRawPR,
    reviews: { ...sampleRawPR.reviews, pageInfo: { hasNextPage: true } },
  };
  const warns: string[] = [];
  summarisePR(truncated, (m) => warns.push(m));
  assert.match(warns[0] ?? "", /reviews \(>100\)/);
});

test("summarisePR: warns when review threads are truncated", () => {
  const truncated = {
    ...sampleRawPR,
    reviewThreads: {
      ...sampleRawPR.reviewThreads,
      pageInfo: { hasNextPage: true },
    },
  };
  const warns: string[] = [];
  summarisePR(truncated, (m) => warns.push(m));
  assert.match(warns[0] ?? "", /review threads \(>100\)/);
});

test("summarisePR: warns when status-check contexts are truncated", () => {
  // The status-check rollup has its own contexts connection; its
  // pageInfo is nested two levels deep, which makes it the
  // easiest one to forget when adding new fields. Pin it.
  const rollup = sampleRawPR.commits.nodes[0]?.commit.statusCheckRollup;
  if (!rollup) throw new Error("fixture missing rollup");
  const truncated = {
    ...sampleRawPR,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              ...rollup,
              contexts: { ...rollup.contexts, pageInfo: { hasNextPage: true } },
            },
          },
        },
      ],
    },
  };
  const warns: string[] = [];
  summarisePR(truncated, (m) => warns.push(m));
  assert.match(warns[0] ?? "", /status checks \(>100\)/);
});

test("summarisePR: collapses multiple truncations into a single warning line", () => {
  // Issues with > 100 of multiple things are vanishingly rare,
  // but a single line listing every truncated connection is
  // easier to grep for in CI logs than five separate warnings.
  const truncated = {
    ...sampleRawPR,
    labels: { ...sampleRawPR.labels, pageInfo: { hasNextPage: true } },
    reviews: { ...sampleRawPR.reviews, pageInfo: { hasNextPage: true } },
  };
  const warns: string[] = [];
  summarisePR(truncated, (m) => warns.push(m));
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /labels \(>100\), reviews \(>100\)/);
});
