// src/tools/pr/request_reviews.ts
//
// `gh.pr_request_reviews` — THE marquee tool. Requests reviews on
// a PR via GraphQL `requestReviews(input: { ..., botIds })` so
// Copilot, Dependabot, and other custom-app bots are actually
// requested. The REST endpoint
// `POST /repos/:o/:r/pulls/:n/requested_reviewers` silently
// no-ops for bots; that bug is the original reason this whole
// server exists (see `agent-staff-engineer#34`).
//
// Implementation:
//
//   1. Resolve the PR's GraphQL node ID by (repo, number).
//   2. Resolve the supplied logins/slugs to GraphQL node IDs in
//      parallel:
//        - users via `user(login: $l)` — must come back with
//          `__typename: User`, otherwise reject (caller passed
//          a bot login in the wrong slot).
//        - teams via `organization(login: $org).team(slug: $s)`
//          — org is derived from the repo's owner.
//        - bots via `repository.suggestedActors(loginNames: $l,
//          capabilities: [CAN_BE_ASSIGNED])` — must return a
//          node with `__typename: Bot` matching the login,
//          otherwise reject (caller passed a human login in
//          the wrong slot).
//   3. Run the `requestReviews` mutation with the resolved
//      userIds / teamIds / botIds and the `union` flag.
//   4. Read the new review-request set off the response and
//      return it as the canonical output.

import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  lookupPRNodeId,
  parseRepoSlug,
  type RepoCoords,
  repoSlugSchema,
} from "./_shared.js";

const inputSchema = {
  type: "object",
  required: ["repo", "number"],
  properties: {
    repo: repoSlugSchema,
    number: { type: "integer", minimum: 1 },
    user_logins: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Human reviewer logins. Resolved via `user(login)`; a " +
        "login that resolves to a non-User type is rejected with " +
        "a structured error pointing at `bot_logins` instead.",
    },
    team_slugs: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Team slugs (slug only, no `org/` prefix — the org is " +
        "derived from the repo's owner). Only meaningful on " +
        "org-owned repos.",
    },
    bot_logins: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Bot logins (e.g. `copilot-pull-request-reviewer`, " +
        "`dependabot`). Resolved via `repository.suggestedActors` " +
        "and verified to be a `Bot` type — a human login here is " +
        "rejected because the GraphQL `requestReviews` mutation " +
        "would otherwise reject the call as a type mismatch.",
    },
    union: {
      type: "boolean",
      description:
        "false (default): replace the PR's existing requested " +
        "reviewers with this set. true: ADD to the existing set " +
        "without removing any.",
    },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["requested_reviewers", "requested_teams", "requested_bots"],
  properties: {
    requested_reviewers: {
      type: "array",
      items: { type: "string" },
      description: "Logins of human reviewers currently requested on the PR.",
    },
    requested_teams: {
      type: "array",
      items: { type: "string" },
      description: "Slugs of team reviewers currently requested on the PR.",
    },
    requested_bots: {
      type: "array",
      items: { type: "string" },
      description: "Logins of bot reviewers currently requested on the PR.",
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  number: number;
  user_logins?: string[];
  team_slugs?: string[];
  bot_logins?: string[];
  union?: boolean;
}

interface Output {
  requested_reviewers: string[];
  requested_teams: string[];
  requested_bots: string[];
}

interface UserIdResponse {
  user: { id: string; __typename: string } | null;
}

interface TeamIdResponse {
  organization: { team: { id: string } | null } | null;
}

interface BotIdResponse {
  repository: {
    suggestedActors: {
      nodes: Array<
        | { __typename: "Bot"; id: string; login: string }
        | { __typename: "User"; login: string }
      >;
    };
  } | null;
}

interface RequestReviewsResponse {
  requestReviews: {
    pullRequest: {
      reviewRequests: {
        pageInfo: { hasNextPage: boolean };
        nodes: Array<{
          requestedReviewer:
            | { __typename: "User"; login: string }
            | { __typename: "Bot"; login: string }
            | { __typename: "Team"; slug: string }
            | { __typename: "Mannequin"; login: string }
            | null;
        }>;
      };
    };
  };
}

export function registerPRRequestReviewsTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.pr_request_reviews", {
    description:
      "Request reviews on a PR via GraphQL `requestReviews(botIds: " +
      "[...])`. Unlike the REST `RequestReviewers` endpoint, this " +
      "actually requests reviews from BOT accounts (Copilot, " +
      "Dependabot, custom apps); REST silently no-ops for bots, " +
      "which is the original reason this server exists. Logins " +
      "are split into human / team / bot inputs because GraphQL " +
      "resolves each to a different node type and the mutation " +
      "rejects type mismatches. `union: false` (default) replaces " +
      "the existing reviewer set; `true` adds without removing.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(inputSchema, raw, "gh.pr_request_reviews input");
      const userLogins = args.user_logins ?? [];
      const teamSlugs = args.team_slugs ?? [];
      const botLogins = args.bot_logins ?? [];
      // Refuse a no-op call upfront. The mutation accepts empty
      // inputs but the result is ambiguous (in `union: false`
      // mode it would clear all existing reviewers, which the
      // caller almost certainly didn't intend if they reached
      // this tool with no logins).
      if (
        userLogins.length === 0 &&
        teamSlugs.length === 0 &&
        botLogins.length === 0
      ) {
        throw new Error(
          `mcp-github: gh.pr_request_reviews input: at least one of user_logins, team_slugs, bot_logins must be non-empty`,
        );
      }
      const coords = parseRepoSlug(args.repo, "gh.pr_request_reviews input");
      // Run the PR lookup + every ID resolution in parallel.
      // The lookups are independent so this halves the
      // wall-clock cost when reviewing a typical 1-or-2-bot,
      // 1-or-2-human request.
      const [pullRequestId, userIds, teamIds, botIds] = await Promise.all([
        lookupPRNodeId(graphql, coords, args.number, "gh.pr_request_reviews"),
        resolveUserIds(graphql, userLogins),
        resolveTeamIds(graphql, coords.owner, teamSlugs),
        resolveBotIds(graphql, coords, botLogins),
      ]);
      // Build the mutation input incrementally — the GraphQL
      // schema treats a present-but-empty array as "clear", so
      // we omit categories the caller didn't ask about.
      const input: Record<string, unknown> = { pullRequestId };
      if (userIds.length > 0) input.userIds = userIds;
      if (teamIds.length > 0) input.teamIds = teamIds;
      if (botIds.length > 0) input.botIds = botIds;
      input.union = args.union ?? false;
      const data = await graphql<RequestReviewsResponse>(
        "pr/request_reviews",
        { input },
      );
      const out = _readReviewRequestsOff(data);
      return validate<Output>(
        outputSchema,
        out,
        "gh.pr_request_reviews output",
      );
    },
  });
}

// Resolve human logins → GraphQL User IDs. The `user(login)`
// query throws when the login doesn't exist; client.ts will
// surface that as a `GraphqlError`. We additionally check
// `__typename === "User"` because GitHub's GraphQL has been
// known to return `null` for some special cases (deleted
// accounts) without erroring; treating a non-User response as
// a bot-vs-human routing error gives the caller a clearer
// signal than a generic GraphQL error would.
async function resolveUserIds(
  graphql: GraphqlClient,
  logins: readonly string[],
): Promise<string[]> {
  if (logins.length === 0) return [];
  const ids = await Promise.all(
    logins.map(async (login) => {
      const data = await graphql<UserIdResponse>("pr/_user-id", { login });
      if (!data.user) {
        throw new Error(
          `mcp-github: gh.pr_request_reviews: user '${login}' not found`,
        );
      }
      if (data.user.__typename !== "User") {
        throw new Error(
          `mcp-github: gh.pr_request_reviews: '${login}' is not a User (resolved to ${data.user.__typename}); use bot_logins for bot accounts`,
        );
      }
      return data.user.id;
    }),
  );
  return ids;
}

// Resolve team slugs → GraphQL Team IDs. The org is the repo's
// owner. We don't accept `org/slug` form here because team
// slugs are scoped to the repo's owning org by design — a team
// from a different org couldn't review a PR on this repo
// anyway.
async function resolveTeamIds(
  graphql: GraphqlClient,
  org: string,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const ids = await Promise.all(
    slugs.map(async (slug) => {
      const data = await graphql<TeamIdResponse>("pr/_team-id", { org, slug });
      if (!data.organization) {
        throw new Error(
          `mcp-github: gh.pr_request_reviews: organization '${org}' not found (or repo is user-owned, in which case team_slugs is not applicable)`,
        );
      }
      if (!data.organization.team) {
        throw new Error(
          `mcp-github: gh.pr_request_reviews: team '${org}/${slug}' not found`,
        );
      }
      return data.organization.team.id;
    }),
  );
  return ids;
}

// Resolve bot logins → GraphQL Bot IDs via
// `repository.suggestedActors`. This is the only practical
// path: `Query.user(login)` errors out for bots (returns "Could
// not resolve to a User"). suggestedActors with the
// CAN_BE_ASSIGNED capability lists every actor that can be
// associated with the repo, including Copilot / Dependabot /
// custom apps installed on the repo.
//
// We verify `__typename === "Bot"` AND a login match; passing a
// human login here would be silently accepted by the Apollo
// search (humans appear in the same suggestedActors list) but
// would fail the typename check and produce a clean "use
// user_logins" message.
//
// Note: despite its plural name, `loginNames` is declared
// `String` (single) in GitHub's schema — see the comment in
// `_bot-id.graphql`. So we call once per supplied bot login
// rather than batching them all in one query.
async function resolveBotIds(
  graphql: GraphqlClient,
  coords: RepoCoords,
  logins: readonly string[],
): Promise<string[]> {
  if (logins.length === 0) return [];
  const ids = await Promise.all(
    logins.map(async (login) => {
      const data = await graphql<BotIdResponse>("pr/_bot-id", {
        owner: coords.owner,
        name: coords.name,
        login,
      });
      if (!data.repository) {
        throw new Error(
          `mcp-github: gh.pr_request_reviews: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
        );
      }
      const bot = data.repository.suggestedActors.nodes.find(
        (n): n is { __typename: "Bot"; id: string; login: string } =>
          n.__typename === "Bot" && n.login === login,
      );
      if (!bot) {
        // Distinguish "not found at all" from "found but it's a
        // human" so the caller knows which input slot to use.
        const human = data.repository.suggestedActors.nodes.find(
          (n) => n.__typename === "User" && n.login === login,
        );
        if (human) {
          throw new Error(
            `mcp-github: gh.pr_request_reviews: '${login}' is a User, not a Bot — use user_logins for human reviewers`,
          );
        }
        throw new Error(
          `mcp-github: gh.pr_request_reviews: bot '${login}' not found among assignable actors on '${coords.owner}/${coords.name}'`,
        );
      }
      return bot.id;
    }),
  );
  return ids;
}

// Read the post-mutation reviewer state off the response. We
// echo back the actual GitHub-reported set rather than the
// inputs because under `union: false` the response shows the
// post-replace state (which only contains the just-supplied
// reviewers) and under `union: true` it shows the merged set
// (which can include reviewers from BEFORE this call).
//
// `warn` is parameterised so unit tests can capture the
// truncation message without hijacking stderr. Defaults to
// `process.stderr.write`, matching the pattern in
// `summarisePR()`.
//
// Exported for the unit suite under the `_` prefix so the
// truncation-warn behaviour can be pinned without spinning up
// the full handler. Not part of the package's public API
// surface — tests reach in via a direct relative import.
export function _readReviewRequestsOff(
  data: RequestReviewsResponse,
  warn: (msg: string) => void = (msg) =>
    process.stderr.write(`${msg}\n`),
): Output {
  const requested_reviewers: string[] = [];
  const requested_teams: string[] = [];
  const requested_bots: string[] = [];
  for (const node of data.requestReviews.pullRequest.reviewRequests.nodes) {
    const r = node.requestedReviewer;
    if (!r) continue; // null is possible per GraphQL nullability
    switch (r.__typename) {
      case "User":
      case "Mannequin":
        requested_reviewers.push(r.login);
        break;
      case "Bot":
        requested_bots.push(r.login);
        break;
      case "Team":
        requested_teams.push(r.slug);
        break;
    }
  }
  // The mutation response fetches `reviewRequests(first: 100)`.
  // Under `union: true` on a PR that already had > 100 pending
  // reviewers, the readback would silently drop the tail —
  // surface a warning so the caller sees the partial result is
  // intentional rather than a missed reviewer. PRs with > 100
  // pending review-requests are vanishingly rare in practice
  // (GitHub's UI doesn't even paginate the list), so we warn
  // rather than throw.
  if (data.requestReviews.pullRequest.reviewRequests.pageInfo.hasNextPage) {
    warn(
      `mcp-github: gh.pr_request_reviews: PR has more than 100 pending review requests; output is truncated to the first page.`,
    );
  }
  return { requested_reviewers, requested_teams, requested_bots };
}
