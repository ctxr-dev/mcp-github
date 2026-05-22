// tests/unit/tools/org/issue_types_list.test.ts
//
// gh.org_issue_types_list: pin the REST route + org param,
// the wire-shape → summary mapping, and the input-schema
// rejection of malformed org logins.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerOrgIssueTypesListTool } from "../../../../src/tools/org/issue_types_list.ts";
import type { ToolEntry } from "../../../../src/registry.ts";
import { sampleRawIssueType, stubAuthedRequest } from "./_fixtures.ts";

function captureRegistration() {
  let entry: ToolEntry | undefined;
  const register = (name: string, e: ToolEntry) => {
    if (name !== "gh.org_issue_types_list") {
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

test("gh.org_issue_types_list: hits GET /orgs/{org}/issue-types with the supplied org", async () => {
  const { authedRequest, calls } = stubAuthedRequest({
    "GET /orgs/{org}/issue-types": [sampleRawIssueType],
  });
  const reg = captureRegistration();
  registerOrgIssueTypesListTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({ org: "my-org" })) as {
    types: Array<{ id: number; name: string }>;
  };
  assert.equal(out.types.length, 1);
  assert.equal(out.types[0]?.id, 1001);
  assert.equal(out.types[0]?.name, "Feature");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params.org, "my-org");
});

test("gh.org_issue_types_list: maps every wire field onto the summary 1:1", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /orgs/{org}/issue-types": [
      { ...sampleRawIssueType, id: 2, name: "Bug", color: "red", description: null, is_enabled: false },
    ],
  });
  const reg = captureRegistration();
  registerOrgIssueTypesListTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({ org: "my-org" })) as {
    types: Array<{
      id: number;
      name: string;
      color: string | null;
      description: string | null;
      is_enabled: boolean;
    }>;
  };
  assert.deepEqual(out.types[0], {
    id: 2,
    name: "Bug",
    description: null,
    color: "red",
    is_enabled: false,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-02T00:00:00Z",
  });
});

test("gh.org_issue_types_list: empty list passes through cleanly", async () => {
  const { authedRequest } = stubAuthedRequest({
    "GET /orgs/{org}/issue-types": [],
  });
  const reg = captureRegistration();
  registerOrgIssueTypesListTool(reg.register, authedRequest);
  const out = (await reg.entry.handler({ org: "my-org" })) as {
    types: unknown[];
  };
  assert.deepEqual(out.types, []);
});

test("gh.org_issue_types_list: rejects malformed org login at the input boundary", async () => {
  const { authedRequest } = stubAuthedRequest({});
  const reg = captureRegistration();
  registerOrgIssueTypesListTool(reg.register, authedRequest);
  // Trailing hyphen — invalid GitHub login.
  await assert.rejects(
    reg.entry.handler({ org: "my-org-" }),
    /gh\.org_issue_types_list input/,
  );
});

test("gh.org_issue_types_list: rejects missing org at the input boundary", async () => {
  const { authedRequest } = stubAuthedRequest({});
  const reg = captureRegistration();
  registerOrgIssueTypesListTool(reg.register, authedRequest);
  await assert.rejects(
    reg.entry.handler({}),
    /gh\.org_issue_types_list input/,
  );
});
