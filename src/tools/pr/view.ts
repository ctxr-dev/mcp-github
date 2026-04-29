// src/tools/pr/view.ts
//
// `gh.pr_view` — fetches a PR with reviews + review-comment count
// + status-checks rolled in. The output shape (`PRSummary`) is
// shared with create/edit (and list, which returns an array of
// these), so consumers see the same fields regardless of how
// they got the PR payload. gh.pr_merge has its own smaller
// `{merged, sha, url, number}` shape because the merge mutation
// only guarantees those fields and a full re-fetch would be
// wasted work.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type PRSummary,
  type RawPR,
  parseRepoSlug,
  prSummarySchema,
  repoSlugSchema,
  summarisePR,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
}

interface Response {
  repository: { pullRequest: RawPR | null } | null;
}

export function registerPRViewTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_view", {
    description:
      "Fetch a PR with reviews, review-comment count, and " +
      "status-checks summary. Returns the canonical PRSummary " +
      "shape used by every PR tool that produces a full payload.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_view input");
      const coords = parseRepoSlug(args.repo, "gh.pr_view input");
      const data = await graphql<Response>("pr/view", {
        owner: coords.owner,
        name: coords.name,
        number: args.number,
      });
      // Distinguish "repo missing / no access" from "PR missing" so
      // a typo in the slug doesn't surface as a misleading
      // "PR not found" message.
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.pr_view: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      const pr = data.repository.pullRequest;
      if (!pr) {
        throw new Error(
          `mcp-github: gh.pr_view: PR ${coords.owner}/${coords.name}#${args.number} not found`,
        );
      }
      const summary = summarisePR(pr);
      return validate<PRSummary>(prSummarySchema, summary, "gh.pr_view output");
    },
  });
}
