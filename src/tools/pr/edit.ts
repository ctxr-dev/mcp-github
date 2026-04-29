// src/tools/pr/edit.ts
//
// `gh.pr_edit` — updates fields on an existing PR. Two-step:
// look up the PR's GraphQL node ID, then run UpdatePullRequest
// with only the fields that were supplied. Omitting a field
// leaves it unchanged; passing `null` is rejected by the input
// schema (we don't accept it as a "clear" sentinel because the
// underlying mutation has no concept of clearing title/body).

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type PRSummary,
  type RawPR,
  lookupPRNodeId,
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
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    base: { type: "string", minLength: 1 },
    draft: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

interface EditResponse {
  updatePullRequest: { pullRequest: RawPR };
}

export function registerPREditTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_edit", {
    description:
      "Update fields on an existing PR. Each field is independent " +
      "and optional; omitting a field leaves it unchanged. " +
      "`base` retargets the PR; `draft: true|false` toggles the " +
      "draft state. Returns the updated PRSummary.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_edit input");
      const coords = parseRepoSlug(args.repo, "gh.pr_edit input");
      const pullRequestId = await lookupPRNodeId(
        graphql,
        coords,
        args.number,
        "gh.pr_edit",
      );
      const input: Record<string, unknown> = { pullRequestId };
      if (args.title !== undefined) input.title = args.title;
      if (args.body !== undefined) input.body = args.body;
      if (args.base !== undefined) input.baseRefName = args.base;
      // The GraphQL `UpdatePullRequestInput` accepts `state` for
      // open/close, not `draft`. Toggling draft uses a separate
      // mutation pair (markPullRequestReadyForReview /
      // convertPullRequestToDraft). We expose `draft` here as a
      // single-direction signal: if supplied, it routes to
      // whichever sibling mutation matches. Implemented below.
      const data =
        args.draft === undefined
          ? await graphql<EditResponse>("pr/edit", { input })
          : await applyEditWithDraftToggle(
              graphql,
              pullRequestId,
              input,
              args.draft,
            );
      const summary = summarisePR(data.updatePullRequest.pullRequest);
      return validate<PRSummary>(prSummarySchema, summary, "gh.pr_edit output");
    },
  });
}

// When the caller supplies `draft`, we run the title/body/base
// edit first (if any of those fields were also set) AND the
// draft-toggle mutation second. Order matters: the toggle's
// pullRequest payload becomes the response, so a same-call
// `title + draft` edit returns a PR carrying both the new title
// AND the new draft state. The pr/edit response is intentionally
// discarded.
async function applyEditWithDraftToggle(
  graphql: GraphqlClient,
  pullRequestId: string,
  input: Record<string, unknown>,
  draft: boolean,
): Promise<EditResponse> {
  // Only run pr/edit when the caller changed fields besides
  // `draft`. The input always carries `pullRequestId`, so a
  // length of 1 means draft-only and we skip the no-op call.
  if (Object.keys(input).length > 1) {
    await graphql<EditResponse>("pr/edit", { input });
  }
  const toggleQuery = draft ? "pr/_to-draft" : "pr/_ready-for-review";
  const toggleResp = await graphql<{
    convertPullRequestToDraft?: { pullRequest: RawPR };
    markPullRequestReadyForReview?: { pullRequest: RawPR };
  }>(toggleQuery, { input: { pullRequestId } });
  const pr =
    toggleResp.convertPullRequestToDraft?.pullRequest ??
    toggleResp.markPullRequestReadyForReview?.pullRequest;
  if (!pr) {
    throw new Error(
      `mcp-github: gh.pr_edit: draft-toggle mutation returned no pullRequest payload`,
    );
  }
  return { updatePullRequest: { pullRequest: pr } };
}
