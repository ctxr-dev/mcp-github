// src/tools/pr/merge.ts
//
// `gh.pr_merge` — merges a PR using one of three methods (merge,
// squash, rebase). Branch-protection failures, mergeability
// blocks, and conflicts come back from GitHub as GraphQL errors;
// `client.ts`'s mapper turns them into structured `GraphqlError`
// instances so the caller sees the rejection reason rather than
// a generic crash.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  lookupPRNodeId,
  parseRepoSlug,
  repoSlugSchema,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "number", "method"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    method: { type: "string", enum: ["merge", "squash", "rebase"] },
    commit_title: {
      type: "string",
      minLength: 1,
      description: "Override the merge-commit subject (merge / squash only).",
    },
    commit_message: {
      type: "string",
      description:
        "Override the merge-commit body (merge / squash only). Pass " +
        "empty string to clear; omit to keep GitHub's default.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  // sha + number are documented contract: the handler always
  // emits them (sha is null only when GitHub returns no
  // mergeCommit, e.g. for rebase merges). Listing them in
  // `required` means an accidental omission (e.g. a future
  // refactor that drops a field from the GraphQL response) trips
  // output validation here rather than landing on consumers as a
  // partial payload.
  required: ["merged", "sha", "url", "number"],
  properties: {
    merged: { type: "boolean" },
    sha: { type: ["string", "null"] },
    url: { type: "string" },
    number: { type: "integer" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  method: "merge" | "squash" | "rebase";
  commit_title?: string;
  commit_message?: string;
}

interface Output {
  merged: boolean;
  sha: string | null;
  url: string;
  number: number;
}

interface MergeResponse {
  mergePullRequest: {
    pullRequest: {
      number: number;
      url: string;
      merged: boolean;
      mergeCommit: { oid: string } | null;
    };
  };
}

const METHOD_GRAPHQL: Record<Input["method"], "MERGE" | "SQUASH" | "REBASE"> = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
};

export function registerPRMergeTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_merge", {
    description:
      "Merge a PR via merge | squash | rebase. Branch-protection " +
      "failures and mergeability blocks come back as structured " +
      "GraphqlError. Returns `{merged, sha, url, number}`.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_merge input");
      const coords = parseRepoSlug(args.repo, "gh.pr_merge input");
      const pullRequestId = await lookupPRNodeId(
        graphql,
        coords,
        args.number,
        "gh.pr_merge",
      );
      const input: Record<string, unknown> = {
        pullRequestId,
        mergeMethod: METHOD_GRAPHQL[args.method],
      };
      if (args.method !== "rebase") {
        // Rebase merges have no merge commit, so commit_title /
        // commit_message are ignored — GitHub returns an error if
        // they're set with REBASE. Drop them silently for the
        // rebase path; users who passed them probably meant the
        // commit body that ends up on the rebased commits, which
        // we don't control here.
        if (args.commit_title !== undefined) {
          input.commitHeadline = args.commit_title;
        }
        if (args.commit_message !== undefined) {
          input.commitBody = args.commit_message;
        }
      }
      const data = await graphql<MergeResponse>("pr/merge", { input });
      const out: Output = {
        merged: data.mergePullRequest.pullRequest.merged,
        sha: data.mergePullRequest.pullRequest.mergeCommit?.oid ?? null,
        url: data.mergePullRequest.pullRequest.url,
        number: data.mergePullRequest.pullRequest.number,
      };
      return validate<Output>(outputSchema, out, "gh.pr_merge output");
    },
  });
}
