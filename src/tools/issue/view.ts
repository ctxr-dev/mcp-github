// src/tools/issue/view.ts
//
// `gh.issue_view` — fetches a single issue by `repo` + `number`.
// Returns the canonical IssueSummary shape (see ./_shared.ts), so
// every consumer of an issue payload across this domain reads the
// same fields. The mutation tools (create/edit/close) build their
// response by feeding the GraphQL `Issue` payload through the same
// `summariseIssue()` helper.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type IssueSummary,
  type RawIssue,
  issueSummarySchema,
  parseRepoSlug,
  repoSlugSchema,
  summariseIssue,
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
  repository: { issue: RawIssue | null } | null;
}

export function registerIssueViewTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.issue_view", {
    description:
      "Fetch a single issue by repository and number. Returns the " +
      "canonical issue summary (number, url, node_id, title, state, " +
      "body, labels[], assignees[], author, timestamps).",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.issue_view input");
      const coords = parseRepoSlug(args.repo, "gh.issue_view input");
      const data = await graphql<Response>("issue/view", {
        owner: coords.owner,
        name: coords.name,
        number: args.number,
      });
      // Distinguish "repo missing / no access" from "issue missing"
      // so a typo in the slug doesn't surface as a misleading
      // "issue not found" message that points at the wrong axis.
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.issue_view: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      const issue = data.repository.issue;
      if (!issue) {
        throw new Error(
          `mcp-github: gh.issue_view: issue ${coords.owner}/${coords.name}#${args.number} not found`,
        );
      }
      const summary = summariseIssue(issue);
      return validate<IssueSummary>(
        issueSummarySchema,
        summary,
        "gh.issue_view output",
      );
    },
  });
}
