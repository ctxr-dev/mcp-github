// tests/unit/tools/project/item_update_field.test.ts
//
// gh.project_item_update_field: pin the value-tagged-union
// behaviour at the schema boundary (exactly-one-of) and the
// snake_case → camelCase translation in the GraphQL input.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerProjectItemUpdateFieldTool } from "../../../../src/tools/project/item_update_field.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.project_item_update_field") throw new Error(`unexpected: ${name}`);
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

const sampleResponse = {
  updateProjectV2ItemFieldValue: {
    projectV2Item: {
      id: "PVTI_target",
      updatedAt: "2026-04-29T00:00:00Z",
    },
  },
};

test("gh.project_item_update_field: text value passes through unchanged", async () => {
  const { graphql } = stubGraphqlClient({
    "project/item_update_field": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.projectId, "PVT_X");
      assert.equal(input.itemId, "PVTI_X");
      assert.equal(input.fieldId, "PVTF_X");
      assert.deepEqual(input.value, { text: "hello" });
      return sampleResponse;
    },
  });
  const reg = captureRegistration();
  registerProjectItemUpdateFieldTool(reg.register, graphql);
  const out = await reg.entry.handler({
    project_id: "PVT_X",
    item_id: "PVTI_X",
    field_id: "PVTF_X",
    value: { text: "hello" },
  });
  assert.deepEqual(out, {
    item_id: "PVTI_target",
    updated_at: "2026-04-29T00:00:00Z",
  });
});

test("gh.project_item_update_field: snake-case single_select_option_id → camelCase singleSelectOptionId", async () => {
  // GraphQL field naming convention requires camelCase. Pin the
  // translation so a future refactor that drops the snake-case
  // input shape breaks here visibly.
  const { graphql } = stubGraphqlClient({
    "project/item_update_field": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.deepEqual(input.value, { singleSelectOptionId: "OPT_in_progress" });
      return sampleResponse;
    },
  });
  const reg = captureRegistration();
  registerProjectItemUpdateFieldTool(reg.register, graphql);
  await reg.entry.handler({
    project_id: "PVT_X",
    item_id: "PVTI_X",
    field_id: "PVTF_X",
    value: { single_select_option_id: "OPT_in_progress" },
  });
});

test("gh.project_item_update_field: iteration_id → iterationId", async () => {
  const { graphql } = stubGraphqlClient({
    "project/item_update_field": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.deepEqual(input.value, { iterationId: "ITER_2026Q2" });
      return sampleResponse;
    },
  });
  const reg = captureRegistration();
  registerProjectItemUpdateFieldTool(reg.register, graphql);
  await reg.entry.handler({
    project_id: "PVT_X",
    item_id: "PVTI_X",
    field_id: "PVTF_X",
    value: { iteration_id: "ITER_2026Q2" },
  });
});

test("gh.project_item_update_field: rejects mixing two value branches", async () => {
  const { graphql } = stubGraphqlClient({
    "project/item_update_field": () => {
      throw new Error("must not run when input shape is invalid");
    },
  });
  const reg = captureRegistration();
  registerProjectItemUpdateFieldTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      item_id: "PVTI_X",
      field_id: "PVTF_X",
      // Both `text` AND `number` set — schema's oneOf must
      // reject. Otherwise GraphQL would silently pick whichever
      // it processes first.
      value: { text: "hi", number: 5 },
    }),
    /gh\.project_item_update_field input/,
  );
});

test("gh.project_item_update_field: rejects empty value object", async () => {
  const { graphql } = stubGraphqlClient({
    "project/item_update_field": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerProjectItemUpdateFieldTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      item_id: "PVTI_X",
      field_id: "PVTF_X",
      value: {},
    }),
    /gh\.project_item_update_field input/,
  );
});

test("gh.project_item_update_field: rejects malformed date format (not YYYY-MM-DD)", async () => {
  const { graphql } = stubGraphqlClient({
    "project/item_update_field": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerProjectItemUpdateFieldTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      item_id: "PVTI_X",
      field_id: "PVTF_X",
      value: { date: "not-a-date" },
    }),
    /gh\.project_item_update_field input/,
  );
});
