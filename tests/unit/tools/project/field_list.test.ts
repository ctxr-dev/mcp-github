// tests/unit/tools/project/field_list.test.ts
//
// gh.project_field_list: pin the polymorphic ProjectV2 field
// flattening — single-select carries `options[]`, iteration
// merges current + completed iterations into the same shape,
// other field types come back with `options: []`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerProjectFieldListTool } from "../../../../src/tools/project/field_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.project_field_list") throw new Error(`unexpected: ${name}`);
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

test("gh.project_field_list: flattens common, single-select, and iteration fields uniformly", async () => {
  const { graphql } = stubGraphqlClient({
    "project/field_list": {
      node: {
        __typename: "ProjectV2",
        fields: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              __typename: "ProjectV2Field",
              id: "PVTF_text",
              name: "Notes",
              dataType: "TEXT",
            },
            {
              __typename: "ProjectV2SingleSelectField",
              id: "PVTSF_status",
              name: "Status",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "OPT_todo", name: "Todo" },
                { id: "OPT_done", name: "Done" },
              ],
            },
            {
              __typename: "ProjectV2IterationField",
              id: "PVTIF_sprint",
              name: "Sprint",
              dataType: "ITERATION",
              configuration: {
                iterations: [{ id: "ITER_q2", title: "2026-Q2" }],
                completedIterations: [{ id: "ITER_q1", title: "2026-Q1" }],
              },
            },
          ],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerProjectFieldListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ project_id: "PVT_X" })) as {
    fields: Array<{
      id: string;
      name: string;
      data_type: string;
      options: Array<{ id: string; name: string }>;
    }>;
    hasNextPage: boolean;
  };
  assert.equal(out.fields.length, 3);
  // Common field: empty options array.
  assert.equal(out.fields[0]?.id, "PVTF_text");
  assert.equal(out.fields[0]?.data_type, "TEXT");
  assert.deepEqual(out.fields[0]?.options, []);
  // Single-select: options pass through.
  assert.deepEqual(
    out.fields[1]?.options.map((o) => o.id),
    ["OPT_todo", "OPT_done"],
  );
  // Iteration: current + completed merge, current first.
  assert.deepEqual(
    out.fields[2]?.options.map((o) => o.id),
    ["ITER_q2", "ITER_q1"],
  );
  assert.equal(out.hasNextPage, false);
});

test("gh.project_field_list: throws when project_id resolves to a non-ProjectV2 node", async () => {
  // Defends against the easy footgun where someone passes an
  // Issue's GraphQL ID as `project_id`. node() would return the
  // Issue, our typename check rejects it.
  const { graphql } = stubGraphqlClient({
    "project/field_list": {
      node: { __typename: "Issue" },
    },
  });
  const reg = captureRegistration();
  registerProjectFieldListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ project_id: "I_kwDO_42" }),
    /'I_kwDO_42' does not resolve to a ProjectV2/,
  );
});

test("gh.project_field_list: owner+number path resolves project id first", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "project/_resolve-project-id": {
      organization: { projectV2: { id: "PVT_resolved" } },
      user: null,
    },
    "project/field_list": (vars: Record<string, unknown>) => {
      assert.equal(vars.projectId, "PVT_resolved");
      return {
        node: {
          __typename: "ProjectV2",
          fields: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerProjectFieldListTool(reg.register, graphql);
  await reg.entry.handler({ owner: "myorg", number: 1 });
  assert.deepEqual(
    calls.map((c) => c.queryName),
    ["project/_resolve-project-id", "project/field_list"],
  );
});

test("gh.project_field_list: throws clear error when project not found by owner+number", async () => {
  const { graphql } = stubGraphqlClient({
    "project/_resolve-project-id": {
      organization: null,
      user: null,
    },
  });
  const reg = captureRegistration();
  registerProjectFieldListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ owner: "ghost", number: 999 }),
    /'ghost\/projects\/999' not found/,
  );
});
