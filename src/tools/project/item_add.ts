// src/tools/project/item_add.ts
//
// `gh.project_item_add` — adds an issue or PR to a Project v2
// board. Two valid input shapes for the project reference
// (project_id OR owner+number) and two valid input shapes for
// the content reference (content_id OR content_url). Each pair
// is enforced by `oneOf` blocks at the schema boundary so a
// caller can't slip a half-specified reference past the input
// gate.
//
// content_url is the gh-CLI-friendly form
// (`https://github.com/owner/repo/issues/N` or `.../pull/N`);
// the handler parses + looks up the GraphQL ID before calling
// the AddProjectV2ItemById mutation.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  lookupContentIdByUrl,
  projectRefOneOf,
  projectRefSchemaProps,
  resolveProjectId,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  properties: {
    ...projectRefSchemaProps,
    content_id: {
      type: "string",
      minLength: 1,
      description: "GraphQL node ID of the issue/PR to add.",
    },
    content_url: {
      type: "string",
      pattern: "^https://github\\.com/",
      description:
        "GitHub URL of an issue (`.../issues/N`) or pull " +
        "(`.../pull/N`). Resolved to the underlying GraphQL node " +
        "ID via a small lookup query before the mutation runs. " +
        "Mutually exclusive with content_id.",
    },
  },
  // Compose the project-ref oneOf and the content-ref oneOf
  // into a single `allOf` so both groups are independently
  // enforced. ajv interprets allOf as "every branch must
  // validate", which gives us the cross-product we want.
  allOf: [
    { oneOf: [...projectRefOneOf] },
    {
      oneOf: [
        {
          required: ["content_id"],
          not: { required: ["content_url"] },
        },
        {
          required: ["content_url"],
          not: { required: ["content_id"] },
        },
      ],
    },
  ],
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["item_id"],
  properties: {
    item_id: { type: "string" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  project_id?: string;
  owner?: string;
  number?: number;
  content_id?: string;
  content_url?: string;
}

interface Output {
  item_id: string;
}

interface AddResponse {
  addProjectV2ItemById: { item: { id: string } };
}

export function registerProjectItemAddTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.project_item_add", {
    description:
      "Add an issue or pull request to a Project v2 board. " +
      "Project ref: either `project_id` (raw GraphQL node ID) or " +
      "`owner + number` (the project URL form). Content ref: " +
      "either `content_id` (raw GraphQL node ID of the issue/PR) " +
      "or `content_url` (e.g. `https://github.com/o/r/issues/N`). " +
      "Schema enforces exactly one of each pair.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.project_item_add input");
      const [projectId, contentId] = await Promise.all([
        resolveProjectId(graphql, args, "gh.project_item_add"),
        args.content_id !== undefined
          ? Promise.resolve(args.content_id)
          : lookupContentIdByUrl(
              graphql,
              args.content_url as string,
              "gh.project_item_add",
            ),
      ]);
      const data = await graphql<AddResponse>("project/item_add", {
        input: { projectId, contentId },
      });
      const out: Output = { item_id: data.addProjectV2ItemById.item.id };
      return validate<Output>(outputSchema, out, "gh.project_item_add output");
    },
  });
}
