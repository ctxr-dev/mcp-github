// tests/unit/tools/project/item_add.test.ts
//
// gh.project_item_add: pin the two cross-product oneOf shapes
// (project ref × content ref), the URL parser, and the
// post-resolve mutation input shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerProjectItemAddTool } from "../../../../src/tools/project/item_add.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import {
  projectIdResolutionOrgWins,
  stubGraphqlClient,
} from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.project_item_add") throw new Error(`unexpected: ${name}`);
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

test("gh.project_item_add: project_id + content_id path skips both lookups, runs only the mutation", async () => {
  let mutationInput: Record<string, unknown> | undefined;
  const { graphql, calls } = stubGraphqlClient({
    "project/item_add": (vars: Record<string, unknown>) => {
      mutationInput = vars.input as Record<string, unknown>;
      return { addProjectV2ItemById: { item: { id: "PVTI_new" } } };
    },
  });
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  const out = await reg.entry.handler({
    project_id: "PVT_existing",
    content_id: "I_existing",
  });
  assert.deepEqual(out, { item_id: "PVTI_new" });
  assert.deepEqual(mutationInput, {
    projectId: "PVT_existing",
    contentId: "I_existing",
  });
  // No resolution calls, just the mutation.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.queryName, "project/item_add");
});

test("gh.project_item_add: owner+number + content_url resolves both before the mutation", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "project/_resolve-project-id": projectIdResolutionOrgWins,
    "project/_resolve-content-id": (vars: Record<string, unknown>) => {
      assert.equal(vars.owner, "myorg");
      assert.equal(vars.name, "myrepo");
      assert.equal(vars.number, 42);
      return {
        repository: {
          issue: { id: "I_kwDO_42" },
          pullRequest: null,
        },
      };
    },
    "project/item_add": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.projectId, "PVT_kwDO_proj");
      assert.equal(input.contentId, "I_kwDO_42");
      return { addProjectV2ItemById: { item: { id: "PVTI_new" } } };
    },
  });
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  await reg.entry.handler({
    owner: "myorg",
    number: 1,
    content_url: "https://github.com/myorg/myrepo/issues/42",
  });
  // Both resolution queries + the mutation.
  assert.equal(calls.length, 3);
});

test("gh.project_item_add: pull URL routes to the pullRequest field on the content lookup", async () => {
  const { graphql } = stubGraphqlClient({
    "project/_resolve-project-id": projectIdResolutionOrgWins,
    "project/_resolve-content-id": () => ({
      repository: {
        issue: null,
        pullRequest: { id: "PR_kwDO_99" },
      },
    }),
    "project/item_add": (vars: Record<string, unknown>) => {
      assert.equal(
        (vars.input as Record<string, unknown>).contentId,
        "PR_kwDO_99",
      );
      return { addProjectV2ItemById: { item: { id: "PVTI_pr" } } };
    },
  });
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  const out = await reg.entry.handler({
    owner: "myorg",
    number: 1,
    content_url: "https://github.com/myorg/myrepo/pull/99",
  });
  assert.equal((out as { item_id: string }).item_id, "PVTI_pr");
});

test("gh.project_item_add: rejects mixing project_id with owner/number", async () => {
  // The schema's project-ref oneOf must reject the four-field
  // mixed shape so an under-specified call can't slip through.
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      owner: "myorg",
      number: 1,
      content_id: "I_Y",
    }),
    /gh\.project_item_add input/,
  );
});

test("gh.project_item_add: rejects mixing content_id with content_url", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      content_id: "I_Y",
      content_url: "https://github.com/o/r/issues/1",
    }),
    /gh\.project_item_add input/,
  );
});

test("gh.project_item_add: rejects malformed content_url", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  // The schema's `pattern: "^https://github\\.com/"` rejects
  // upfront; a URL that passes the pattern but isn't a real
  // issue/PR path also gets a clean error from the parser.
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      content_url: "https://github.com/foo",
    }),
    /not a recognised github\.com issue or pull URL/,
  );
});

test("gh.project_item_add: rejects URL with garbage tail after the issue number", async () => {
  // `.../issues/123abc` previously parsed as 123 because the
  // regex didn't anchor a boundary after the numeric segment.
  // Pin the rejection so a typo can never silently resolve to
  // the wrong issue.
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerProjectItemAddTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({
      project_id: "PVT_X",
      content_url: "https://github.com/o/r/issues/123abc",
    }),
    /not a recognised github\.com issue or pull URL/,
  );
});
