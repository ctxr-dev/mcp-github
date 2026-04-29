// src/tools/label/create.ts
//
// `gh.label_create` — creates a label on a repository.
// CreateLabelInput needs the repository's GraphQL node ID, so a
// small `_repo-id` lookup runs first. Color is normalised to
// lowercase to match how GitHub stores it; passing `D73A4A`
// returns `d73a4a`.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type LabelSummary,
  type RawLabel,
  colorSchema,
  labelSummarySchema,
  lookupRepoNodeId,
  parseRepoSlug,
  repoSlugSchema,
  summariseLabel,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "name", "color"],
  properties: {
    repo: repoSlugSchema,
    name: { type: "string", minLength: 1 },
    color: colorSchema,
    description: { type: "string" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  name: string;
  color: string;
  description?: string;
}

interface CreateResponse {
  createLabel: { label: RawLabel };
}

export function registerLabelCreateTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.label_create", {
    description:
      "Create a label on a repository. `color` is a 6-digit hex " +
      "value without `#`; supplied case-insensitively. Returns the " +
      "canonical LabelSummary including url + node_id.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.label_create input");
      const coords = parseRepoSlug(args.repo, "gh.label_create input");
      const repositoryId = await lookupRepoNodeId(
        graphql,
        coords,
        "gh.label_create",
      );
      const input: Record<string, unknown> = {
        repositoryId,
        name: args.name,
        color: args.color.toLowerCase(),
      };
      if (args.description !== undefined) input.description = args.description;
      const data = await graphql<CreateResponse>("label/create", { input });
      const summary = summariseLabel(data.createLabel.label);
      return validate<LabelSummary>(
        labelSummarySchema,
        summary,
        "gh.label_create output",
      );
    },
  });
}
