// tests/unit/tools/label/list_edit.test.ts
//
// Combined coverage for the two simpler label tools — list (paginated
// pass-through) and edit (lookup → update). One test file because
// both surfaces are small.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerLabelListTool } from "../../../../src/tools/label/list.ts";
import { registerLabelEditTool } from "../../../../src/tools/label/edit.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { rawLabel, stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration(name: string) {
  let entry: ToolEntry | undefined;
  const register = (n: string, e: ToolEntry) => {
    if (n !== name) throw new Error(`unexpected: ${n}`);
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

test("gh.label_list: returns alphabetised page with pagination shape", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "label/list": {
      repository: {
        labels: {
          pageInfo: { hasNextPage: true, endCursor: "C123" },
          nodes: [
            rawLabel({ id: "LA_bug", name: "bug", color: "d73a4a" }),
            rawLabel({ id: "LA_p1", name: "p1", color: "0e8a16" }),
          ],
        },
      },
    },
  });
  const reg = captureRegistration("gh.label_list");
  registerLabelListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ repo: "owner/repo" })) as {
    items: Array<{ name: string; node_id: string }>;
    hasNextPage: boolean;
    endCursor: string | null;
  };
  assert.equal(out.items.length, 2);
  assert.deepEqual(
    out.items.map((i) => i.name),
    ["bug", "p1"],
  );
  assert.equal(out.hasNextPage, true);
  assert.equal(out.endCursor, "C123");
  assert.equal(calls[0]?.vars.first, 30);
});

test("gh.label_edit: looks up existing label by name, then runs UpdateLabel with only the supplied fields", async () => {
  const { graphql } = stubGraphqlClient({
    "label/_lookup": {
      repository: {
        label: rawLabel({ id: "LA_bug", name: "bug", color: "d73a4a" }),
      },
    },
    "label/edit": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.id, "LA_bug");
      assert.equal(input.name, "defect");
      assert.equal(input.color, "ee0701");
      // description not supplied → must be absent from input
      // (GraphQL would reject explicit `undefined`/`null` here).
      assert.equal("description" in input, false);
      return {
        updateLabel: {
          label: rawLabel({
            id: "LA_bug",
            name: "defect",
            color: "ee0701",
          }),
        },
      };
    },
  });
  const reg = captureRegistration("gh.label_edit");
  registerLabelEditTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    name: "bug",
    new_name: "defect",
    color: "EE0701",
  })) as { name: string; color: string };
  assert.equal(out.name, "defect");
  assert.equal(out.color, "ee0701");
});

test("gh.label_edit: throws structured error when the label doesn't exist", async () => {
  const { graphql } = stubGraphqlClient({
    "label/_lookup": { repository: { label: null } },
  });
  const reg = captureRegistration("gh.label_edit");
  registerLabelEditTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", name: "ghost", color: "ffffff" }),
    /label 'ghost' not found in 'owner\/repo'/,
  );
});
