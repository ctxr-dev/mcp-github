// src/tools/label/list.ts
//
// `gh.label_list` — paginated label list, ordered alphabetically.
// Uses the same `{items, hasNextPage, endCursor}` shape as
// gh.issue_list / gh.pr_list so pagination is consistent across
// the tool surface.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type LabelSummary,
  type RawLabel,
  labelSummarySchema,
  parseRepoSlug,
  repoSlugSchema,
  summariseLabel,
} from "./_shared.js";

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

const inputSchema = {
  type: "object",
  required: ["repo"],
  properties: {
    repo: repoSlugSchema,
    perPage: { type: "integer", minimum: 1, maximum: PER_PAGE_MAX },
    after: {
      type: "string",
      minLength: 1,
      description: "Opaque cursor from a previous page's endCursor.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["items", "hasNextPage", "endCursor"],
  properties: {
    items: { type: "array", items: labelSummarySchema },
    hasNextPage: { type: "boolean" },
    endCursor: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  perPage?: number;
  after?: string;
}

interface Output {
  items: LabelSummary[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Response {
  repository: {
    labels: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawLabel[];
    };
  } | null;
}

export function registerLabelListTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.label_list", {
    description:
      "List labels in a repo, alphabetised. Returns one page; " +
      "advance with the returned `endCursor`.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.label_list input");
      const coords = parseRepoSlug(args.repo, "gh.label_list input");
      const data = await graphql<Response>("label/list", {
        owner: coords.owner,
        name: coords.name,
        first: args.perPage ?? PER_PAGE_DEFAULT,
        after: args.after ?? null,
      });
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.label_list: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      const out: Output = {
        items: data.repository.labels.nodes.map(summariseLabel),
        hasNextPage: data.repository.labels.pageInfo.hasNextPage,
        endCursor: data.repository.labels.pageInfo.endCursor,
      };
      return validate<Output>(outputSchema, out, "gh.label_list output");
    },
  });
}
