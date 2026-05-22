// tests/unit/tools/org/issue_type_create.test.ts
//
// gh.org_issue_type_create: pin the org-id lookup → createIssueType
// flow, the lowercase ↔ uppercase color translation at the
// boundary, the optional-field passthrough behaviour, and the
// schema's rejection of unknown colors.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerOrgIssueTypeCreateTool } from "../../../../src/tools/org/issue_type_create.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { stubGraphqlClient } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.org_issue_type_create") {
      throw new Error(`unexpected: ${name}`);
    }
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

test("gh.org_issue_type_create: org-id lookup → createIssueType with mapped color", async () => {
  const { graphql, calls } = stubGraphqlClient({
    "org/_org-id": (vars: Record<string, unknown>) => {
      assert.equal(vars.login, "my-org");
      return { organization: { id: "O_org" } };
    },
    "org/issue_type_create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      assert.equal(input.ownerId, "O_org");
      assert.equal(input.name, "Epic");
      // Lowercase user input → uppercase GraphQL enum.
      assert.equal(input.color, "PURPLE");
      assert.equal(input.description, "Top-level mission");
      assert.equal(input.isEnabled, true);
      return {
        createIssueType: {
          issueType: {
            id: "IT_kw_1",
            name: "Epic",
            color: "PURPLE",
            description: "Top-level mission",
            isEnabled: true,
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerOrgIssueTypeCreateTool(reg.register, graphql);
  const out = (await reg.entry.handler({
    org: "my-org",
    name: "Epic",
    color: "purple",
    description: "Top-level mission",
    is_enabled: true,
  })) as {
    node_id: string;
    color: string | null;
    name: string;
    is_enabled: boolean;
  };
  // Output color normalised back to lowercase; id key is
  // `node_id` to match the convention on other summaries.
  assert.deepEqual(out, {
    node_id: "IT_kw_1",
    name: "Epic",
    color: "purple",
    description: "Top-level mission",
    is_enabled: true,
  });
  assert.equal(calls.length, 2);
});

test("gh.org_issue_type_create: omits color / description / is_enabled when not supplied", async () => {
  const { graphql } = stubGraphqlClient({
    "org/_org-id": () => ({ organization: { id: "O_org" } }),
    "org/issue_type_create": (vars: Record<string, unknown>) => {
      const input = vars.input as Record<string, unknown>;
      // Optional fields STAY absent rather than serialised as
      // explicit undefined / null (GraphQL would reject).
      assert.equal("color" in input, false);
      assert.equal("description" in input, false);
      assert.equal("isEnabled" in input, false);
      return {
        createIssueType: {
          issueType: {
            id: "IT_kw_2",
            name: "Bare",
            color: null,
            description: null,
            isEnabled: true,
          },
        },
      };
    },
  });
  const reg = captureRegistration();
  registerOrgIssueTypeCreateTool(reg.register, graphql);
  const out = (await reg.entry.handler({ org: "my-org", name: "Bare" })) as {
    color: string | null;
    description: string | null;
  };
  assert.equal(out.color, null);
  assert.equal(out.description, null);
});

test("gh.org_issue_type_create: org-not-found surfaces a structured error", async () => {
  const { graphql } = stubGraphqlClient({
    "org/_org-id": () => ({ organization: null }),
  });
  const reg = captureRegistration();
  registerOrgIssueTypeCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ org: "my-org", name: "Epic" }),
    /organization 'my-org' not found/,
  );
});

test("gh.org_issue_type_create: rejects an unknown color enum at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerOrgIssueTypeCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ org: "my-org", name: "Epic", color: "magenta" }),
    /gh\.org_issue_type_create input/,
  );
});

test("gh.org_issue_type_create: rejects empty name at the input boundary", async () => {
  const { graphql } = stubGraphqlClient({});
  const reg = captureRegistration();
  registerOrgIssueTypeCreateTool(reg.register, graphql);
  await assert.rejects(
    reg.entry.handler({ org: "my-org", name: "" }),
    /gh\.org_issue_type_create input/,
  );
});
