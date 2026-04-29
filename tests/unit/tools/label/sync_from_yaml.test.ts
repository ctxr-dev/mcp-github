// tests/unit/tools/label/sync_from_yaml.test.ts
//
// gh.label_sync_from_yaml: pin the install/reconcile semantics
// + the diff-report shape + the YAML acceptance forms (top-level
// array vs `labels:` key) + the idempotent-rerun contract that
// the spec calls out.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerLabelSyncFromYamlTool } from "../../../../src/tools/label/sync_from_yaml.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { rawLabel, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.label_sync_from_yaml") throw new Error(`unexpected: ${name}`);
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

const TAXONOMY_YAML = `\
- name: bug
  color: d73a4a
  description: Something is broken
- name: enhancement
  color: a2eeef
  description: Feature request
`;

test("gh.label_sync_from_yaml: install mode creates missing labels, leaves drifted ones unchanged", async () => {
  // Repo currently has `bug` (drifted color) + `chore` (extra).
  // Install mode: `enhancement` is created; `bug` is left alone
  // even though its color drifts; `chore` is left alone (would
  // only be deleted in reconcile mode).
  const { graphql, calls } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            rawLabel({ id: "LA_bug", name: "bug", color: "ff0000" }),
            rawLabel({ id: "LA_chore", name: "chore", color: "888888" }),
          ],
        },
      },
    },
    "label/_repo-id": { repository: { id: "R_repo" } },
    "label/create": () => ({
      createLabel: { label: rawLabel({ name: "enhancement" }) },
    }),
    "label/edit": () => {
      throw new Error("install mode must NOT update existing labels");
    },
    "label/delete": () => {
      throw new Error("install mode must NOT delete labels");
    },
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    yaml_text: TAXONOMY_YAML,
    mode: "install",
  })) as {
    mode: string;
    created: Array<{ name: string }>;
    updated: Array<{ name: string }>;
    deleted: Array<{ name: string }>;
    unchanged: Array<{ name: string }>;
  };
  assert.equal(out.mode, "install");
  assert.deepEqual(
    out.created.map((c) => c.name),
    ["enhancement"],
  );
  assert.deepEqual(out.updated, []);
  assert.deepEqual(out.deleted, []);
  // bug is in YAML + on repo (drifted), so it's "unchanged" under
  // install semantics. chore is on repo only — install doesn't
  // touch it; it doesn't appear anywhere in the report (only
  // labels mentioned in the YAML walk through unchanged).
  assert.deepEqual(
    out.unchanged.map((u) => u.name),
    ["bug"],
  );
  // One label/list, one repo-id lookup, one create.
  assert.equal(
    calls.filter((c) => c.queryName === "label/create").length,
    1,
  );
});

test("gh.label_sync_from_yaml: reconcile mode creates + updates + deletes", async () => {
  // Same starting state as the install test: bug (drifted), chore
  // (extra). Reconcile should: create enhancement, update bug
  // (color), delete chore.
  const { graphql, calls } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            rawLabel({ id: "LA_bug", name: "bug", color: "ff0000" }),
            rawLabel({ id: "LA_chore", name: "chore", color: "888888" }),
          ],
        },
      },
    },
    "label/_repo-id": { repository: { id: "R_repo" } },
    "label/create": () => ({
      createLabel: { label: rawLabel({ name: "enhancement" }) },
    }),
    "label/edit": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.id, "LA_bug");
      assert.equal(input.color, "d73a4a");
      assert.equal(input.description, "Something is broken");
      return {
        updateLabel: { label: rawLabel({ name: "bug", color: "d73a4a" }) },
      };
    },
    "label/delete": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.id, "LA_chore");
      return { deleteLabel: { clientMutationId: null } };
    },
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    yaml_text: TAXONOMY_YAML,
    mode: "reconcile",
  })) as {
    created: Array<{ name: string }>;
    updated: Array<{ name: string; changes: string[] }>;
    deleted: Array<{ name: string }>;
    unchanged: Array<{ name: string }>;
  };
  assert.deepEqual(
    out.created.map((c) => c.name),
    ["enhancement"],
  );
  assert.equal(out.updated.length, 1);
  assert.equal(out.updated[0]?.name, "bug");
  assert.ok(out.updated[0]?.changes.includes("color"));
  assert.deepEqual(
    out.deleted.map((d) => d.name),
    ["chore"],
  );
  assert.deepEqual(out.unchanged, []);
  assert.equal(
    calls.filter((c) => c.queryName === "label/delete").length,
    1,
  );
});

test("gh.label_sync_from_yaml: idempotent rerun on a synced repo produces all-unchanged report", async () => {
  // Spec: "Tests cover create-new + idempotent-rerun + colour-diff
  // detection." Repo state matches the YAML exactly → second run
  // should not make any mutations and the report should put both
  // labels under `unchanged`.
  const { graphql, calls } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            rawLabel({
              id: "LA_bug",
              name: "bug",
              color: "d73a4a",
              description: "Something is broken",
            }),
            rawLabel({
              id: "LA_enh",
              name: "enhancement",
              color: "a2eeef",
              description: "Feature request",
            }),
          ],
        },
      },
    },
    "label/_repo-id": { repository: { id: "R_repo" } },
    "label/create": () => {
      throw new Error("idempotent rerun must NOT create labels");
    },
    "label/edit": () => {
      throw new Error("idempotent rerun must NOT update labels");
    },
    "label/delete": () => {
      throw new Error("idempotent rerun must NOT delete labels");
    },
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    yaml_text: TAXONOMY_YAML,
    mode: "reconcile",
  })) as {
    created: unknown[];
    updated: unknown[];
    deleted: unknown[];
    unchanged: Array<{ name: string }>;
  };
  assert.deepEqual(out.created, []);
  assert.deepEqual(out.updated, []);
  assert.deepEqual(out.deleted, []);
  assert.deepEqual(
    out.unchanged.map((u) => u.name).sort(),
    ["bug", "enhancement"],
  );
  // Only the list call ran — no mutations.
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["label/list"],
  );
});

test("gh.label_sync_from_yaml: colour-diff detection — describes the changed field", async () => {
  // Spec mentions colour-diff explicitly; pin that the `changes`
  // array carries `color` and not `description` when only colour
  // differs.
  const { graphql } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            rawLabel({
              id: "LA_bug",
              name: "bug",
              color: "ff0000",
              description: "Something is broken",
            }),
          ],
        },
      },
    },
    "label/_repo-id": { repository: { id: "R_repo" } },
    "label/edit": () => ({ updateLabel: { label: rawLabel({ name: "bug" }) } }),
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    yaml_text: `- name: bug
  color: d73a4a
  description: Something is broken
`,
    mode: "reconcile",
  })) as { updated: Array<{ name: string; changes: string[] }> };
  assert.equal(out.updated.length, 1);
  assert.deepEqual(out.updated[0]?.changes, ["color"]);
});

test("gh.label_sync_from_yaml: accepts the `labels:` key form too", async () => {
  const { graphql } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
    "label/_repo-id": { repository: { id: "R_repo" } },
    "label/create": () => ({
      createLabel: { label: rawLabel({ name: "x" }) },
    }),
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    yaml_text: `\
labels:
  - name: x
    color: ffffff
`,
    mode: "install",
  })) as { created: Array<{ name: string }> };
  assert.deepEqual(
    out.created.map((c) => c.name),
    ["x"],
  );
});

test("gh.label_sync_from_yaml: throws on malformed YAML", async () => {
  const { graphql } = stubGraphqlClient({
    "label/list": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  // Use a syntactically invalid YAML: unclosed flow-sequence and
  // flow-mapping in the same string. Plain "wrong indentation"
  // doesn't fail (yaml is permissive about strings), but flow
  // tokens have to balance.
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      yaml_text: "[unclosed: {bracket",
      mode: "install",
    }),
    /yaml parse failed/,
  );
});

test("gh.label_sync_from_yaml: throws on YAML that's not an array or labels object", async () => {
  const { graphql } = stubGraphqlClient({
    "label/list": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      yaml_text: `wrong_root: 42`,
      mode: "install",
    }),
    /must be a top-level array of labels or an object with a 'labels' array/,
  );
});

test("gh.label_sync_from_yaml: throws on truncated label list (>100 labels)", async () => {
  // Mirrors the issue domain's truncation contract: v0.1 caps at
  // 100 labels because pagination would add complexity
  // disproportionate to the rare case.
  const { graphql } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: true, endCursor: "C" },
          nodes: [],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerLabelSyncFromYamlTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      yaml_text: TAXONOMY_YAML,
      mode: "install",
    }),
    /more than 100 labels/,
  );
});
