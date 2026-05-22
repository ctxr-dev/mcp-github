// src/tools/project/field_list.ts
//
// `gh.project_field_list` — lists every field configured on a
// Project v2 board, including the per-field options for
// SINGLE_SELECT and per-field iterations for ITERATION fields.
// Caller uses this output to discover field IDs + valid option
// IDs before calling gh.project_item_update_field.
//
// Implementation reads through `node(id: $projectId)` so the
// query works for both Organization-owned and User-owned
// projects without branching.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type ProjectFieldOption,
  type ProjectFieldSummary,
  type ProjectFieldType,
  projectFieldSummarySchema,
  projectRefOneOf,
  projectRefSchemaProps,
  resolveProjectId,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: { ...projectRefSchemaProps },
  allOf: [{ oneOf: [...projectRefOneOf] }],
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["fields", "hasNextPage"],
  properties: {
    fields: { type: "array", items: projectFieldSummarySchema },
    hasNextPage: {
      type: "boolean",
      description:
        "True when the project has > 100 fields (the GraphQL " +
        "page cap). Vanishingly rare in practice; surfaces as a " +
        "signal that pagination support is needed.",
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  project_id?: string;
  owner?: string;
  number?: number;
}

interface Output {
  fields: ProjectFieldSummary[];
  hasNextPage: boolean;
}

interface RawFieldCommon {
  __typename: "ProjectV2Field";
  id: string;
  name: string;
  dataType: ProjectFieldType;
}

interface RawFieldSingleSelect {
  __typename: "ProjectV2SingleSelectField";
  id: string;
  name: string;
  dataType: ProjectFieldType;
  options: ProjectFieldOption[];
}

interface RawFieldIteration {
  __typename: "ProjectV2IterationField";
  id: string;
  name: string;
  dataType: ProjectFieldType;
  configuration: {
    iterations: Array<{ id: string; title: string }>;
    completedIterations: Array<{ id: string; title: string }>;
  };
}

type RawField = RawFieldCommon | RawFieldSingleSelect | RawFieldIteration;

interface ProjectV2Node {
  __typename: "ProjectV2";
  fields: {
    pageInfo: { hasNextPage: boolean };
    nodes: RawField[];
  };
}

interface Response {
  // `node()` returns a polymorphic Node | null. We narrow via
  // the helper below rather than a discriminated-union type so
  // the literal `"ProjectV2"` check actually performs the
  // narrowing — TS can't narrow when one arm of the union has
  // `__typename: string`.
  node: { __typename: string } | null;
}

function isProjectV2(node: Response["node"]): node is ProjectV2Node {
  return node !== null && node.__typename === "ProjectV2";
}

export function registerProjectFieldListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.project_field_list", {
    description:
      "List the fields configured on a Project v2 board. For " +
      "SINGLE_SELECT fields each entry's `options` carries the " +
      "selectable option IDs + names; for ITERATION fields the " +
      "current and completed iterations appear in the same " +
      "`options` array (current iterations come first). Use " +
      "this to discover IDs before calling " +
      "`gh.project_item_update_field`.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.project_field_list input");
      const projectId = await resolveProjectId(
        graphql,
        args,
        "gh.project_field_list",
      );
      const data = await graphql<Response>("project/field_list", { projectId });
      if (!isProjectV2(data.node)) {
        // The `node()` lookup returns null for an unknown ID
        // and a non-ProjectV2 typename for an ID that resolves
        // to something else (e.g. an Issue ID accidentally
        // passed as project_id). Both surface as a clean error.
        throw new Error(
          `mcp-github: gh.project_field_list: project_id '${projectId}' does not resolve to a ProjectV2`,
        );
      }
      const fields = data.node.fields.nodes.map(summariseField);
      const out: Output = {
        fields,
        hasNextPage: data.node.fields.pageInfo.hasNextPage,
      };
      return validate<Output>(outputSchema, out, "gh.project_field_list output");
    },
  });
}

function summariseField(raw: RawField): ProjectFieldSummary {
  if (raw.__typename === "ProjectV2SingleSelectField") {
    return {
      id: raw.id,
      name: raw.name,
      data_type: raw.dataType,
      options: raw.options,
    };
  }
  if (raw.__typename === "ProjectV2IterationField") {
    // Combine current + completed iterations into the same
    // `options` array so the consumer doesn't have to switch on
    // the typename. Current iterations are listed first because
    // those are the ones a fresh update is most likely to
    // target.
    return {
      id: raw.id,
      name: raw.name,
      data_type: raw.dataType,
      options: [
        ...raw.configuration.iterations.map((i) => ({ id: i.id, name: i.title })),
        ...raw.configuration.completedIterations.map((i) => ({
          id: i.id,
          name: i.title,
        })),
      ],
    };
  }
  return {
    id: raw.id,
    name: raw.name,
    data_type: raw.dataType,
    options: [],
  };
}
