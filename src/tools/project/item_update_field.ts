// src/tools/project/item_update_field.ts
//
// `gh.project_item_update_field` — updates one field on a
// Project v2 item. The field-value input is a tagged union over
// the five user-configurable Project v2 field types: text,
// number, date, single-select option, iteration. Schema's
// `oneOf` enforces exactly one branch — passing more than one
// (or none) is rejected at the input boundary so the underlying
// mutation never sees an ambiguous payload.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  projectRefOneOf,
  projectRefSchemaProps,
  resolveProjectId,
} from "./_shared.js";

const valueSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    number: { type: "number" },
    date: {
      type: "string",
      format: "date",
      description: "ISO-8601 date (YYYY-MM-DD), no time component.",
    },
    single_select_option_id: { type: "string", minLength: 1 },
    iteration_id: { type: "string", minLength: 1 },
  },
  // Exactly one of the five branches. Empty `value: {}` (none)
  // and double-set values (e.g. text + number) are both
  // rejected.
  oneOf: [
    {
      required: ["text"],
      not: {
        anyOf: [
          { required: ["number"] },
          { required: ["date"] },
          { required: ["single_select_option_id"] },
          { required: ["iteration_id"] },
        ],
      },
    },
    {
      required: ["number"],
      not: {
        anyOf: [
          { required: ["text"] },
          { required: ["date"] },
          { required: ["single_select_option_id"] },
          { required: ["iteration_id"] },
        ],
      },
    },
    {
      required: ["date"],
      not: {
        anyOf: [
          { required: ["text"] },
          { required: ["number"] },
          { required: ["single_select_option_id"] },
          { required: ["iteration_id"] },
        ],
      },
    },
    {
      required: ["single_select_option_id"],
      not: {
        anyOf: [
          { required: ["text"] },
          { required: ["number"] },
          { required: ["date"] },
          { required: ["iteration_id"] },
        ],
      },
    },
    {
      required: ["iteration_id"],
      not: {
        anyOf: [
          { required: ["text"] },
          { required: ["number"] },
          { required: ["date"] },
          { required: ["single_select_option_id"] },
        ],
      },
    },
  ],
  additionalProperties: false,
} as const;

const inputSchema = {
  type: "object",
  required: ["item_id", "field_id", "value"],
  properties: {
    ...projectRefSchemaProps,
    item_id: {
      type: "string",
      minLength: 1,
      description: "Project v2 item GraphQL node ID.",
    },
    field_id: {
      type: "string",
      minLength: 1,
      description: "Project v2 field GraphQL node ID.",
    },
    value: valueSchema,
  },
  allOf: [{ oneOf: [...projectRefOneOf] }],
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["item_id", "updated_at"],
  properties: {
    item_id: { type: "string" },
    updated_at: { type: "string" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  project_id?: string;
  owner?: string;
  number?: number;
  item_id: string;
  field_id: string;
  value: {
    text?: string;
    number?: number;
    date?: string;
    single_select_option_id?: string;
    iteration_id?: string;
  };
}

interface Output {
  item_id: string;
  updated_at: string;
}

interface UpdateResponse {
  updateProjectV2ItemFieldValue: {
    projectV2Item: { id: string; updatedAt: string };
  };
}

export function registerProjectItemUpdateFieldTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.project_item_update_field", {
    description:
      "Update one field on a Project v2 item. `value` is a tagged " +
      "union: pass exactly one of `text`, `number`, `date` " +
      "(YYYY-MM-DD), `single_select_option_id`, or `iteration_id`. " +
      "The choice must match the field's data type — passing " +
      "a `text` value to a SINGLE_SELECT field returns a clean " +
      "GraphQL error from GitHub.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.project_item_update_field input",
      );
      const projectId = await resolveProjectId(
        graphql,
        args,
        "gh.project_item_update_field",
      );
      // Translate snake-case input keys to GraphQL camel-case.
      const value: Record<string, unknown> = {};
      if (args.value.text !== undefined) value.text = args.value.text;
      if (args.value.number !== undefined) value.number = args.value.number;
      if (args.value.date !== undefined) value.date = args.value.date;
      if (args.value.single_select_option_id !== undefined) {
        value.singleSelectOptionId = args.value.single_select_option_id;
      }
      if (args.value.iteration_id !== undefined) {
        value.iterationId = args.value.iteration_id;
      }
      const data = await graphql<UpdateResponse>(
        "project/item_update_field",
        {
          input: {
            projectId,
            itemId: args.item_id,
            fieldId: args.field_id,
            value,
          },
        },
      );
      const out: Output = {
        item_id: data.updateProjectV2ItemFieldValue.projectV2Item.id,
        updated_at: data.updateProjectV2ItemFieldValue.projectV2Item.updatedAt,
      };
      return validate<Output>(
        outputSchema,
        out,
        "gh.project_item_update_field output",
      );
    },
  });
}
