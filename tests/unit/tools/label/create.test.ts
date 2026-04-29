// tests/unit/tools/label/create.test.ts
//
// gh.label_create: pin the repo-id lookup → mutation flow,
// the color normalisation, and the input-validation boundary
// (color regex + missing required fields).

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerLabelCreateTool } from "../../../../src/tools/label/create.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { rawLabel, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.label_create") throw new Error(`unexpected: ${name}`);
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

test("gh.label_create: looks up repo id, then creates the label", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "label/_repo-id": { repository: { id: "R_kwDO_repo" } },
    "label/create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.repositoryId, "R_kwDO_repo");
      assert.equal(input.name, "bug");
      assert.equal(input.color, "d73a4a");
      assert.equal(input.description, "Something is broken");
      return {
        createLabel: {
          label: rawLabel({
            id: "LA_bug",
            name: "bug",
            color: "d73a4a",
            description: "Something is broken",
            url: "https://github.com/owner/repo/labels/bug",
          }),
        },
      };
    },
  });
  const reg = captureRegistration();
  registerLabelCreateTool(reg.register, graphql);
  const out = await reg.entry.handler({
    repo: "owner/repo",
    name: "bug",
    color: "d73a4a",
    description: "Something is broken",
  });
  assert.deepEqual(out, {
    name: "bug",
    color: "d73a4a",
    description: "Something is broken",
    url: "https://github.com/owner/repo/labels/bug",
    node_id: "LA_bug",
  });
  assert.equal(calls.length, 2);
});

test("gh.label_create: normalises uppercase color to lowercase before submitting", async () => {
  const { graphql } = stubGraphqlClient({
    "label/_repo-id": { repository: { id: "R_kwDO_repo" } },
    "label/create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.color, "d73a4a");
      return {
        createLabel: {
          label: rawLabel({ name: "x", color: "d73a4a" }),
        },
      };
    },
  });
  const reg = captureRegistration();
  registerLabelCreateTool(reg.register, graphql);
  await reg.entry.handler({ repo: "owner/repo", name: "x", color: "D73A4A" });
});

test("gh.label_create: rejects bad color format at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({
    "label/_repo-id": { repository: { id: "R" } },
    "label/create": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerLabelCreateTool(reg.register, graphql);
  // Leading hash, short hex, non-hex chars all rejected by the
  // pattern `^[0-9a-fA-F]{6}$`.
  for (const bad of ["#d73a4a", "abc", "deadbeef", "zzz000"]) {
    await assert.rejects(
      reg.entry.handler({ repo: "owner/repo", name: "x", color: bad }),
      /gh\.label_create input/,
    );
  }
});

test("gh.label_create: throws when the repository is not found", async () => {
  const { graphql } = stubGraphqlClient({
    "label/_repo-id": { repository: null },
    "label/create": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerLabelCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", name: "x", color: "abcdef" }),
    /repository 'owner\/repo' not found/,
  );
});
