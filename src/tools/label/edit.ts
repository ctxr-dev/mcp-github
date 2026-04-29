// src/tools/label/edit.ts
//
// `gh.label_edit` — updates a label by name. Two-step: look up
// the label's GraphQL node ID by name, then run UpdateLabel with
// only the fields that were supplied. `new_name` renames; the
// other fields update in place.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type LabelSummary,
  type RawLabel,
  colorSchema,
  labelSummarySchema,
  lookupLabelByName,
  parseRepoSlug,
  repoSlugSchema,
  summariseLabel,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "name"],
  properties: {
    repo: repoSlugSchema,
    name: { type: "string", minLength: 1 },
    new_name: { type: "string", minLength: 1 },
    color: colorSchema,
    description: { type: "string" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  name: string;
  new_name?: string;
  color?: string;
  description?: string;
}

interface EditResponse {
  updateLabel: { label: RawLabel };
}

export function registerLabelEditTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.label_edit", {
    description:
      "Update a label's name / color / description. Looked up by " +
      "current `name`; pass `new_name` to rename.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.label_edit input");
      const coords = parseRepoSlug(args.repo, "gh.label_edit input");
      const existing = await lookupLabelByName(
        graphql,
        coords,
        args.name,
        "gh.label_edit",
      );
      const input: Record<string, unknown> = { id: existing.id };
      if (args.new_name !== undefined) input.name = args.new_name;
      if (args.color !== undefined) input.color = args.color.toLowerCase();
      if (args.description !== undefined) input.description = args.description;
      const data = await graphql<EditResponse>("label/edit", { input });
      const summary = summariseLabel(data.updateLabel.label);
      return validate<LabelSummary>(
        labelSummarySchema,
        summary,
        "gh.label_edit output",
      );
    },
  });
}
