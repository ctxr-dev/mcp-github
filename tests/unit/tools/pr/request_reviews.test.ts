// tests/unit/tools/pr/request_reviews.test.ts
//
// gh.pr_request_reviews — the marquee tool. The single-most-
// important assertion in this file is that the tool calls the
// GraphQL `pr/request_reviews` mutation with `botIds` populated.
// REST `POST /repos/.../requested_reviewers` would silently
// no-op for bots; if a future regression accidentally routed
// bot logins through the REST path or dropped them from the
// GraphQL input, every test here that asserts botIds presence
// would fail.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  registerPRRequestReviewsTool,
  _readReviewRequestsOff,
} from "../../../../src/tools/pr/request_reviews.ts";
import { GraphqlError } from "../../../../src/graphql/errors.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.pr_request_reviews") throw new Error(`unexpected: ${name}`);
    entry = e;
  };
  return {
    register,
    get entry(): ToolEntry {
      if (!entry) throw new Error("not registered");
      return entry;
    },
  };
}

// Canonical mutation response: a PR with one of each reviewer
// type so the readback path is exercised end-to-end. Override
// per-test by spreading.
const sampleMutationResponse = {
  requestReviews: {
    pullRequest: {
      reviewRequests: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            requestedReviewer: {
              __typename: "User" as const,
              login: "alice",
            },
          },
          {
            requestedReviewer: {
              __typename: "Bot" as const,
              login: "copilot-pull-request-reviewer",
            },
          },
          {
            requestedReviewer: {
              __typename: "Team" as const,
              slug: "platform",
            },
          },
        ],
      },
    },
  },
};

test("gh.pr_request_reviews: routes bot logins through GraphQL botIds (the marquee path)", async () => {
  // The whole point of MCP-6: bot reviewers MUST go through the
  // GraphQL mutation's `botIds` input. The earlier path under
  // `@github/mcp-server-github` used the REST endpoint, which
  // silently no-ops for bots. Pin that:
  //
  //   - the resolved bot ID flows into mutation input as botIds
  //   - userIds and teamIds stay empty when only bots are
  //     supplied, so the call shape is unambiguous
  let mutationInput: Record<string, unknown> | undefined;
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_bot-id": (vars: Record<string, unknown>) => {
      assert.equal(vars.login, "copilot-pull-request-reviewer");
      return {
        repository: {
          suggestedActors: {
            nodes: [
              {
                __typename: "Bot",
                id: "BOT_copilot",
                login: "copilot-pull-request-reviewer",
              },
            ],
          },
        },
      };
    },
    "pr/request_reviews": (vars: Record<string, unknown>) => {
      mutationInput = vars.input as Record<string, unknown>;
      return sampleMutationResponse;
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    bot_logins: ["copilot-pull-request-reviewer"],
  })) as { requested_bots: string[] };
  assert.deepEqual(mutationInput, {
    pullRequestId: "PR_target",
    botIds: ["BOT_copilot"],
    union: false,
  });
  assert.deepEqual(out.requested_bots, ["copilot-pull-request-reviewer"]);
  // The mutation MUST be `pr/request_reviews`, not anything
  // resembling a REST path. (The stub already enforces this by
  // throwing on unmocked queries, but the assertion makes the
  // intent visible in the test name.)
  assert.ok(
    calls.some((c) => c.queryName === "pr/request_reviews"),
    "MUST call the GraphQL pr/request_reviews mutation, not REST",
  );
});

test("gh.pr_request_reviews: resolves human + team + bot in parallel, splits the readback", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_user-id": (vars: Record<string, unknown>) => {
      assert.equal(vars.login, "alice");
      return { user: { id: "U_alice", __typename: "User" } };
    },
    "pr/_team-id": (vars: Record<string, unknown>) => {
      assert.equal(vars.org, "owner");
      assert.equal(vars.slug, "platform");
      return { organization: { team: { id: "T_platform" } } };
    },
    "pr/_bot-id": () => ({
      repository: {
        suggestedActors: {
          nodes: [
            {
              __typename: "Bot",
              id: "BOT_copilot",
              login: "copilot-pull-request-reviewer",
            },
          ],
        },
      },
    }),
    "pr/request_reviews": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.deepEqual(input.userIds, ["U_alice"]);
      assert.deepEqual(input.teamIds, ["T_platform"]);
      assert.deepEqual(input.botIds, ["BOT_copilot"]);
      return sampleMutationResponse;
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    user_logins: ["alice"],
    team_slugs: ["platform"],
    bot_logins: ["copilot-pull-request-reviewer"],
  })) as {
    requested_reviewers: string[];
    requested_teams: string[];
    requested_bots: string[];
  };
  assert.deepEqual(out, {
    requested_reviewers: ["alice"],
    requested_teams: ["platform"],
    requested_bots: ["copilot-pull-request-reviewer"],
  });
  // Resolution order is non-deterministic (Promise.all) but
  // every required query must have run.
  const queries = calls.map((c) => c.queryName).sort();
  assert.deepEqual(queries, [
    "pr/_bot-id",
    "pr/_pr-lookup",
    "pr/_team-id",
    "pr/_user-id",
    "pr/request_reviews",
  ]);
});

test("gh.pr_request_reviews: rejects a human login passed in bot_logins", async () => {
  // Crucial routing check. A caller who puts `octocat` in
  // bot_logins must see a clear "use user_logins" error rather
  // than a confusing "Bot not found" or — worse — a silent
  // no-op once the request hits the mutation.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_bot-id": () => ({
      repository: {
        suggestedActors: {
          nodes: [
            { __typename: "User", login: "octocat" },
          ],
        },
      },
    }),
    "pr/request_reviews": () => {
      throw new Error("mutation must NOT run when bot resolution fails");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 42,
      bot_logins: ["octocat"],
    }),
    /'octocat' is a User, not a Bot — use user_logins/,
  );
});

test("gh.pr_request_reviews: maps GraphqlError from user(login) onto a routing-hint message", async () => {
  // Real-world failure shape: `user(login: "dependabot")`
  // returns a GraphQL `errors[]` ("Could not resolve to a User
  // with the login of 'dependabot'"). client.ts wraps that as
  // a GraphqlError. The handler must catch it and rethrow with
  // a tool-scoped message that points the caller at
  // `bot_logins` — otherwise they'd see a generic
  // GraphqlError and have no idea which input slot to use.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_user-id": () => {
      throw new GraphqlError([
        {
          type: "NOT_FOUND",
          message: "Could not resolve to a User with the login of 'dependabot'.",
        },
      ]);
    },
    "pr/request_reviews": () => {
      throw new Error("mutation must NOT run when user resolution fails");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 42,
      user_logins: ["dependabot"],
    }),
    /'dependabot' could not be resolved as a User .* if this is a bot account, use bot_logins.* otherwise verify the spelling/,
  );
});

test("gh.pr_request_reviews: handles the rare null-user response cleanly", async () => {
  // GitHub's GraphQL has been known to return `{ user: null }`
  // for some special cases (deleted accounts) instead of
  // erroring. Pin that we surface a "user not found" rather
  // than crashing on `data.user.id` access.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_user-id": () => ({ user: null }),
    "pr/request_reviews": () => {
      throw new Error("mutation must NOT run");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 42,
      user_logins: ["ghost-account"],
    }),
    /user 'ghost-account' not found/,
  );
});

test("gh.pr_request_reviews: union: true forwards to mutation input", async () => {
  let mutationInput: Record<string, unknown> | undefined;
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_user-id": () => ({ user: { id: "U_alice", __typename: "User" } }),
    "pr/request_reviews": (vars: Record<string, unknown>) => {
      mutationInput = vars.input as Record<string, unknown>;
      return sampleMutationResponse;
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    user_logins: ["alice"],
    union: true,
  });
  assert.equal(mutationInput?.union, true);
});

test("gh.pr_request_reviews: union defaults to false (replace existing reviewers)", async () => {
  let mutationInput: Record<string, unknown> | undefined;
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_user-id": () => ({ user: { id: "U_alice", __typename: "User" } }),
    "pr/request_reviews": (vars: Record<string, unknown>) => {
      mutationInput = vars.input as Record<string, unknown>;
      return sampleMutationResponse;
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    user_logins: ["alice"],
  });
  assert.equal(mutationInput?.union, false);
});

test("gh.pr_request_reviews: refuses a no-op call where every reviewer slot is empty", async () => {
  // Without this guard, `union: false` + no inputs would
  // CLEAR the existing reviewers — almost certainly not what
  // the caller meant if they reached this tool empty-handed.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": () => {
      throw new Error("must not run when input is empty");
    },
    "pr/request_reviews": () => {
      throw new Error("must not run when input is empty");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ repo: "owner/repo", number: 42 }),
    /at least one of user_logins, team_slugs, bot_logins must be non-empty/,
  );
});

test("gh.pr_request_reviews: skips empty arrays in the mutation input", async () => {
  // GraphQL's RequestReviewsInput treats present-but-empty
  // arrays as "clear that category". When the caller only
  // supplies bots, userIds and teamIds must be ABSENT (not
  // present and empty) so the mutation doesn't accidentally
  // wipe pre-existing human or team reviewers.
  let mutationInput: Record<string, unknown> | undefined;
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_bot-id": () => ({
      repository: {
        suggestedActors: {
          nodes: [
            {
              __typename: "Bot",
              id: "BOT_copilot",
              login: "copilot",
            },
          ],
        },
      },
    }),
    "pr/request_reviews": (vars: Record<string, unknown>) => {
      mutationInput = vars.input as Record<string, unknown>;
      return sampleMutationResponse;
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await reg.entry.handler({
    repo: "owner/repo",
    number: 42,
    bot_logins: ["copilot"],
  });
  assert.equal("userIds" in (mutationInput ?? {}), false);
  assert.equal("teamIds" in (mutationInput ?? {}), false);
  assert.deepEqual(mutationInput?.botIds, ["BOT_copilot"]);
});

test("gh.pr_request_reviews: surfaces 'team not found' clearly when slug doesn't exist", async () => {
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_team-id": () => ({ organization: { team: null } }),
    "pr/request_reviews": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 42,
      team_slugs: ["nonexistent"],
    }),
    /team 'owner\/nonexistent' not found/,
  );
});

test("gh.pr_request_reviews: rejects team_slugs that look like `org/slug`", async () => {
  // Common mis-passing — caller types the team's full path
  // when the schema wants just the slug. Catching it at the
  // boundary produces a schema-validation error pointing at
  // the offending instance path, instead of a confusing
  // "team 'owner/org/slug' not found" later.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": () => {
      throw new Error("must not run when input is malformed");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "owner/repo",
      number: 42,
      team_slugs: ["org/platform"],
    }),
    /gh\.pr_request_reviews input/,
  );
});

test("gh.pr_request_reviews: surfaces clear error when team_slugs are passed on a user-owned repo", async () => {
  // GraphQL `organization(login: $userLogin)` returns null
  // when the login is a User, not an Org. Translate that to a
  // helpful "team_slugs not applicable" message so the caller
  // doesn't think the team was simply missing.
  const { graphql } = stubGraphqlClient({
    "pr/_pr-lookup": { repository: { pullRequest: { id: "PR_target" } } },
    "pr/_team-id": () => ({ organization: null }),
    "pr/request_reviews": () => {
      throw new Error("must not run");
    },
  });
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "person/repo",
      number: 42,
      team_slugs: ["platform"],
    }),
    /team_slugs is not applicable/,
  );
});

test("_readReviewRequestsOff: warns when reviewRequests page is truncated", async () => {
  // The mutation response fetches reviewRequests(first: 100).
  // PRs with > 100 pending review requests are vanishingly rare,
  // but if a `union: true` call lands on one the readback would
  // silently drop the tail. Pin the warn-not-throw contract.
  const truncated = {
    requestReviews: {
      pullRequest: {
        reviewRequests: {
          pageInfo: { hasNextPage: true },
          nodes: [
            {
              requestedReviewer: {
                __typename: "User" as const,
                login: "alice",
              },
            },
          ],
        },
      },
    },
  };
  const warns: string[] = [];
  const out = _readReviewRequestsOff(truncated, (m) => warns.push(m));
  // Output is still emitted (we warn rather than throw); the
  // observable signal lives on stderr.
  assert.deepEqual(out.requested_reviewers, ["alice"]);
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /more than 100 pending review requests/);
});

test("_readReviewRequestsOff: silent on the common, not-truncated case", async () => {
  const normal = {
    requestReviews: {
      pullRequest: {
        reviewRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              requestedReviewer: {
                __typename: "Bot" as const,
                login: "copilot",
              },
            },
          ],
        },
      },
    },
  };
  const warns: string[] = [];
  _readReviewRequestsOff(normal, (m) => warns.push(m));
  assert.equal(warns.length, 0);
});

test("gh.pr_request_reviews: rejects malformed repo slug at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerPRRequestReviewsTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      repo: "no-slash",
      number: 42,
      user_logins: ["alice"],
    }),
    /gh\.pr_request_reviews input/,
  );
});
