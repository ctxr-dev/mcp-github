// src/tools/project/items_list.ts
//
// `gh.project_items_list` — paginated list of items on a
// Project v2 board, with each item's field values flattened
// onto a uniform `{field_id, field_name, type, value}` shape.
// The flattening absorbs the tagged-union complexity of the
// underlying GraphQL `ProjectV2ItemFieldValue` union — a
// consumer building a status board doesn't have to switch on
// __typename to read a value.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type ProjectFieldType,
  projectFieldTypeSchema,
  projectRefOneOf,
  projectRefSchemaProps,
  resolveProjectId,
} from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 50; // GraphQL caps Project v2 items at 50 per page.

const inputSchema = {
  type: "object",
  properties: {
    ...projectRefSchemaProps,
    perPage: { type: "integer", minimum: 1, maximum: PER_PAGE_MAX },
    after: {
      type: "string",
      minLength: 1,
      description: "Opaque cursor from a previous page's endCursor.",
    },
  },
  allOf: [{ oneOf: [...projectRefOneOf] }],
  additionalProperties: false,
} as const;

interface FieldValue {
  field_id: string;
  field_name: string;
  type: ProjectFieldType;
  value: string | number;
}

const fieldValueSchema = {
  type: "object",
  required: ["field_id", "field_name", "type", "value"],
  properties: {
    field_id: { type: "string" },
    field_name: { type: "string" },
    type: projectFieldTypeSchema,
    // The flattened value: text → string, number → number,
    // date → ISO string, single-select → option name (also
    // returns option_id alongside), iteration → title (also
    // returns iteration_id alongside).
    value: { type: ["string", "number"] },
  },
  additionalProperties: false,
} as const;

interface Item {
  id: string;
  updated_at: string;
  content_type: "Issue" | "PullRequest" | "DraftIssue" | "Unknown";
  content_repo: string | null;
  content_number: number | null;
  content_url: string | null;
  content_title: string;
  field_values: FieldValue[];
}

const itemSchema = {
  type: "object",
  required: [
    "id",
    "updated_at",
    "content_type",
    "content_repo",
    "content_number",
    "content_url",
    "content_title",
    "field_values",
  ],
  properties: {
    id: { type: "string" },
    updated_at: { type: "string" },
    content_type: {
      type: "string",
      enum: ["Issue", "PullRequest", "DraftIssue", "Unknown"],
    },
    content_repo: { type: ["string", "null"] },
    content_number: { type: ["integer", "null"] },
    content_url: { type: ["string", "null"] },
    content_title: { type: "string" },
    field_values: { type: "array", items: fieldValueSchema },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: itemSchema },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  project_id?: string;
  owner?: string;
  number?: number;
  perPage?: number;
  after?: string;
}

interface Output {
  items: Item[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// Raw shapes from the items_list GraphQL query.
interface RawFieldCommon {
  id: string;
  name: string;
  dataType: ProjectFieldType;
}

// The five field-value variants the query selects, plus a
// generic fallback. We type the discriminator on the typed
// branches as the literal __typename, but the fallback uses a
// distinct property name so `__typename` stays a literal-only
// discriminator (TS won't narrow against a `string`-typed
// discriminator branch).
type RawFieldValueTyped =
  | { __typename: "ProjectV2ItemFieldTextValue"; text: string; field: RawFieldCommon }
  | { __typename: "ProjectV2ItemFieldNumberValue"; number: number; field: RawFieldCommon }
  | { __typename: "ProjectV2ItemFieldDateValue"; date: string; field: RawFieldCommon }
  | { __typename: "ProjectV2ItemFieldSingleSelectValue"; optionId: string | null; name: string | null; field: RawFieldCommon }
  | { __typename: "ProjectV2ItemFieldIterationValue"; iterationId: string; title: string; field: RawFieldCommon };

type TypedTypename = RawFieldValueTyped["__typename"];

const TYPED_TYPENAMES: ReadonlySet<TypedTypename> = new Set([
  "ProjectV2ItemFieldTextValue",
  "ProjectV2ItemFieldNumberValue",
  "ProjectV2ItemFieldDateValue",
  "ProjectV2ItemFieldSingleSelectValue",
  "ProjectV2ItemFieldIterationValue",
]);

// Raw nodes we accept off the wire. Untyped because GraphQL's
// fieldValues union has many other variants (assignees, labels,
// etc.) that we filter out via TYPED_TYPENAMES below.
type RawFieldValue = { __typename: string } & Record<string, unknown>;

interface RawContentIssueOrPR {
  __typename: "Issue" | "PullRequest";
  number: number;
  url: string;
  title: string;
  repository: { nameWithOwner: string };
}

interface RawContentDraft {
  __typename: "DraftIssue";
  title: string;
}

type RawContent = RawContentIssueOrPR | RawContentDraft | { __typename: string };

interface RawItem {
  id: string;
  updatedAt: string;
  content: RawContent | null;
  fieldValues: {
    pageInfo: { hasNextPage: boolean };
    nodes: RawFieldValue[];
  };
}

interface ProjectV2WithItems {
  __typename: "ProjectV2";
  items: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawItem[];
  };
}

interface Response {
  // Same shape rationale as field_list.ts: keep the response
  // shape loose and narrow via a helper because TS can't narrow
  // a union where one arm has `__typename: string`.
  node: { __typename: string } | null;
}

function isProjectV2WithItems(
  node: Response["node"],
): node is ProjectV2WithItems {
  return node !== null && node.__typename === "ProjectV2";
}

export function registerProjectItemsListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.project_items_list", {
    description:
      "List items on a Project v2 board, with field values " +
      "flattened to `{field_id, field_name, type, value}` so " +
      "callers don't have to switch on the GraphQL union " +
      "typename. Date / number / text values pass through; " +
      "single-select returns the option name as the value " +
      "(consult `gh.project_field_list` for option IDs); " +
      "iteration returns the iteration title.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.project_items_list input");
      const projectId = await resolveProjectId(
        graphql,
        args,
        "gh.project_items_list",
      );
      const data = await graphql<Response>("project/items_list", {
        projectId,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
      });
      if (!isProjectV2WithItems(data.node)) {
        throw new Error(
          `mcp-github: gh.project_items_list: project_id '${projectId}' does not resolve to a ProjectV2`,
        );
      }
      const items = data.node.items.nodes.map(buildItem);
      const out: Output = {
        items,
        hasNextPage: data.node.items.pageInfo.hasNextPage,
        endCursor: data.node.items.pageInfo.endCursor,
      };
      return validate<Output>(outputSchema, out, "gh.project_items_list output");
    },
  });
}

function buildItem(raw: RawItem): Item {
  let content_type: Item["content_type"] = "Unknown";
  let content_repo: string | null = null;
  let content_number: number | null = null;
  let content_url: string | null = null;
  let content_title = "";
  if (raw.content) {
    const c = raw.content as RawContent;
    if (c.__typename === "Issue" || c.__typename === "PullRequest") {
      const ipr = c as RawContentIssueOrPR;
      content_type = ipr.__typename;
      content_repo = ipr.repository.nameWithOwner;
      content_number = ipr.number;
      content_url = ipr.url;
      content_title = ipr.title;
    } else if (c.__typename === "DraftIssue") {
      content_type = "DraftIssue";
      content_title = (c as RawContentDraft).title;
    }
  }
  return {
    id: raw.id,
    updated_at: raw.updatedAt,
    content_type,
    content_repo,
    content_number,
    content_url,
    content_title,
    field_values: raw.fieldValues.nodes.flatMap(flattenFieldValue),
  };
}

// Flatten one tagged-union field-value node onto our flat
// shape. Returns an empty array for the (rare) case where the
// node's __typename isn't one of the five typed variants the
// query selects, so the caller's array still type-checks
// against `FieldValue[]`.
function flattenFieldValue(raw: RawFieldValue): FieldValue[] {
  // Skip untyped fallback variants (assignees, labels, etc.)
  // upfront so the typed cast below is sound.
  if (!TYPED_TYPENAMES.has(raw.__typename as TypedTypename)) return [];
  const typed = raw as RawFieldValueTyped;
  switch (typed.__typename) {
    case "ProjectV2ItemFieldTextValue":
      return [
        {
          field_id: typed.field.id,
          field_name: typed.field.name,
          type: typed.field.dataType,
          value: typed.text,
        },
      ];
    case "ProjectV2ItemFieldNumberValue":
      return [
        {
          field_id: typed.field.id,
          field_name: typed.field.name,
          type: typed.field.dataType,
          value: typed.number,
        },
      ];
    case "ProjectV2ItemFieldDateValue":
      return [
        {
          field_id: typed.field.id,
          field_name: typed.field.name,
          type: typed.field.dataType,
          value: typed.date,
        },
      ];
    case "ProjectV2ItemFieldSingleSelectValue":
      // `name` may be null when the option has been deleted
      // since the value was set; surface "" so the consumer
      // doesn't have to handle null vs string-or-number.
      return [
        {
          field_id: typed.field.id,
          field_name: typed.field.name,
          type: typed.field.dataType,
          value: typed.name ?? "",
        },
      ];
    case "ProjectV2ItemFieldIterationValue":
      return [
        {
          field_id: typed.field.id,
          field_name: typed.field.name,
          type: typed.field.dataType,
          value: typed.title,
        },
      ];
  }
}
