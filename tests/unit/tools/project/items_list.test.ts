// tests/unit/tools/project/items_list.test.ts
//
// gh.project_items_list: pin the field-value flattening (the
// tagged-union union → flat {field_id, field_name, type, value}
// shape) and the content-type bucketing (Issue/PR/DraftIssue).

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerProjectItemsListTool } from "../../../../src/tools/project/items_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.project_items_list") throw new Error(`unexpected: ${name}`);
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

const fieldStatus = { id: "F_status", name: "Status", dataType: "SINGLE_SELECT" };
const fieldNotes = { id: "F_notes", name: "Notes", dataType: "TEXT" };
const fieldEffort = { id: "F_effort", name: "Effort", dataType: "NUMBER" };
const fieldSprint = { id: "F_sprint", name: "Sprint", dataType: "ITERATION" };
const fieldDue = { id: "F_due", name: "Due", dataType: "DATE" };

test("gh.project_items_list: flattens five typed value variants onto the uniform shape", async () => {
  const { graphql } = stubGraphqlClient({
    "project/items_list": {
      node: {
        __typename: "ProjectV2",
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PVTI_a",
              updatedAt: "2026-04-29T00:00:00Z",
              content: {
                __typename: "Issue",
                number: 42,
                url: "https://github.com/o/r/issues/42",
                title: "Sample issue",
                repository: { nameWithOwner: "o/r" },
              },
              fieldValues: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldTextValue",
                    text: "Hello",
                    field: fieldNotes,
                  },
                  {
                    __typename: "ProjectV2ItemFieldNumberValue",
                    number: 5,
                    field: fieldEffort,
                  },
                  {
                    __typename: "ProjectV2ItemFieldDateValue",
                    date: "2026-05-01",
                    field: fieldDue,
                  },
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    optionId: "OPT_in_progress",
                    name: "In progress",
                    field: fieldStatus,
                  },
                  {
                    __typename: "ProjectV2ItemFieldIterationValue",
                    iterationId: "ITER_q2",
                    title: "2026-Q2",
                    field: fieldSprint,
                  },
                  // An untyped variant we don't select for —
                  // must be silently skipped.
                  { __typename: "ProjectV2ItemFieldLabelValue" },
                ],
              },
            },
          ],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerProjectItemsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ project_id: "PVT_X" })) as {
    items: Array<{
      id: string;
      content_type: string;
      content_repo: string | null;
      content_number: number | null;
      content_title: string;
      field_values: Array<{
        field_id: string;
        field_name: string;
        type: string;
        value: string | number;
      }>;
    }>;
    hasNextPage: boolean;
  };
  assert.equal(out.items.length, 1);
  const item = out.items[0]!;
  assert.equal(item.content_type, "Issue");
  assert.equal(item.content_repo, "o/r");
  assert.equal(item.content_number, 42);
  assert.equal(item.content_title, "Sample issue");
  // Five flattened entries (the LabelValue is dropped).
  assert.equal(item.field_values.length, 5);
  assert.deepEqual(
    item.field_values.map((v) => ({ name: v.field_name, value: v.value })),
    [
      { name: "Notes", value: "Hello" },
      { name: "Effort", value: 5 },
      { name: "Due", value: "2026-05-01" },
      { name: "Status", value: "In progress" },
      { name: "Sprint", value: "2026-Q2" },
    ],
  );
});

test("gh.project_items_list: DraftIssue content surfaces with content_type DraftIssue + null repo/number/url", async () => {
  // Drafts are project-only items not backed by an issue/PR.
  // Pin the null-shape so consumers can tell them apart from
  // issue/PR items at a glance.
  const { graphql } = stubGraphqlClient({
    "project/items_list": {
      node: {
        __typename: "ProjectV2",
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PVTI_draft",
              updatedAt: "2026-04-29T00:00:00Z",
              content: {
                __typename: "DraftIssue",
                title: "Draft idea",
              },
              fieldValues: {
                pageInfo: { hasNextPage: false },
                nodes: [],
              },
            },
          ],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerProjectItemsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ project_id: "PVT_X" })) as {
    items: Array<{
      content_type: string;
      content_repo: string | null;
      content_number: number | null;
      content_url: string | null;
      content_title: string;
    }>;
  };
  assert.equal(out.items[0]?.content_type, "DraftIssue");
  assert.equal(out.items[0]?.content_repo, null);
  assert.equal(out.items[0]?.content_number, null);
  assert.equal(out.items[0]?.content_url, null);
  assert.equal(out.items[0]?.content_title, "Draft idea");
});

test("gh.project_items_list: deleted single-select option surfaces value '' instead of null", async () => {
  // GraphQL returns name: null when the option has been deleted
  // since the value was set. We coerce to '' so the consumer's
  // `value: string | number` invariant holds.
  const { graphql } = stubGraphqlClient({
    "project/items_list": {
      node: {
        __typename: "ProjectV2",
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PVTI_a",
              updatedAt: "2026-04-29T00:00:00Z",
              content: null,
              fieldValues: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    optionId: null,
                    name: null,
                    field: fieldStatus,
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });
  const reg = captureRegistration();
  registerProjectItemsListTool(reg.register, graphql);
  const out = (await reg.entry.handler({ project_id: "PVT_X" })) as {
    items: Array<{ field_values: Array<{ value: string | number }> }>;
  };
  assert.equal(out.items[0]?.field_values[0]?.value, "");
});

test("gh.project_items_list: throws when project_id resolves to a non-ProjectV2 node", async () => {
  const { graphql } = stubGraphqlClient({
    "project/items_list": {
      node: { __typename: "Issue" },
    },
  });
  const reg = captureRegistration();
  registerProjectItemsListTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ project_id: "I_kwDO_42" }),
    /does not resolve to a ProjectV2/,
  );
});
