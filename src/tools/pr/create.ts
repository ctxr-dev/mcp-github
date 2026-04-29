// src/tools/pr/create.ts
//
// `gh.pr_create` — opens a PR. CreatePullRequestInput needs the
// repository's GraphQL node ID (not the owner/name pair), so we
// run a small `_repo-id` lookup first. Branch refs are passed
// straight through; cross-repo head refs (e.g. forks) use the
// `owner:branch` form on `headRefName`, same as `gh pr create`.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type PRSummary,
  type RawPR,
  lookupRepoNodeId,
  parseRepoSlug,
  prSummarySchema,
  repoSlugSchema,
  summarisePR,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "base", "head", "title"],
  properties: {
    repo: repoSlugSchema,
    base: { type: "string", minLength: 1 },
    head: {
      type: "string",
      minLength: 1,
      description: "Head ref. Cross-repo: `owner:branch`. Same-repo: `branch`.",
    },
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    draft: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}

interface CreateResponse {
  createPullRequest: { pullRequest: RawPR };
}

export function registerPRCreateTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_create", {
    description:
      "Open a PR. `head` accepts `branch` for same-repo PRs and " +
      "`owner:branch` for cross-repo (fork-based). Returns the " +
      "canonical PRSummary including the new PR's number, url, " +
      "and node_id.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_create input");
      const coords = parseRepoSlug(args.repo, "gh.pr_create input");
      const repositoryId = await lookupRepoNodeId(graphql, coords, "gh.pr_create");
      const input: Record<string, unknown> = {
        repositoryId,
        baseRefName: args.base,
        headRefName: args.head,
        title: args.title,
      };
      if (args.body !== undefined) input.body = args.body;
      if (args.draft !== undefined) input.draft = args.draft;
      const data = await graphql<CreateResponse>("pr/create", { input });
      const summary = summarisePR(data.createPullRequest.pullRequest);
      return validate<PRSummary>(prSummarySchema, summary, "gh.pr_create output");
    },
  });
}
