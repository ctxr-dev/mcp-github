// src/tools/label/sync_from_yaml.ts
//
// `gh.label_sync_from_yaml` — apply a canonical-taxonomy YAML
// document onto a repo's labels. Two modes:
//
//   - install: create labels listed in the YAML that don't exist
//     on the repo. Don't touch existing labels (even if their
//     color/description differs).
//   - reconcile: install behaviour PLUS update labels whose
//     color or description differs, PLUS delete labels on the
//     repo that aren't in the YAML. Reconcile makes the YAML the
//     source of truth.
//
// Output: a diff report listing what was created / updated /
// deleted / left unchanged. The report fully describes the
// effect of the operation; the tool is idempotent (re-running
// the same YAML in reconcile mode produces an all-unchanged
// report).
//
// YAML accepted in two shapes:
//   - top-level array: `[ { name, color, description? }, ... ]`
//   - `labels:` key: `{ labels: [ { name, color, description? }, ... ] }`

import { parse as parseYaml } from "yaml";
import type { GraphqlClient } from "../../graphql/client.js";
import type { ToolEntry } from "../../registry.js";
import { validate } from "../../validation/validator.js";
import {
  type RawLabel,
  colorSchema,
  lookupRepoNodeId,
  parseRepoSlug,
  repoSlugSchema,
} from "./_shared.js";

const LABELS_PAGE_SIZE = 100;
// Hard ceiling on the total label set to detect runaway queries
// (e.g. a misconfigured cursor that fails to advance) without
// exhausting GitHub's rate-limit budget. Real repos top out
// well under this; if you hit it, something is wrong upstream
// rather than a legitimately enormous taxonomy.
const LABELS_TOTAL_CEILING = 5000;

const inputSchema = {
  type: "object",
  required: ["repo", "yaml_text", "mode"],
  properties: {
    repo: repoSlugSchema,
    yaml_text: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["install", "reconcile"] },
  },
  additionalProperties: false,
} as const;

const taxonomyEntrySchema = {
  type: "object",
  required: ["name", "color"],
  properties: {
    name: { type: "string", minLength: 1 },
    color: colorSchema,
    description: { type: "string" },
  },
  additionalProperties: false,
} as const;

const taxonomySchema = {
  type: "array",
  items: taxonomyEntrySchema,
} as const;

const outputSchema = {
  type: "object",
  required: ["created", "updated", "deleted", "unchanged", "mode"],
  properties: {
    mode: { type: "string", enum: ["install", "reconcile"] },
    created: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
    updated: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "changes"],
        properties: {
          name: { type: "string" },
          changes: {
            type: "array",
            items: { type: "string", enum: ["color", "description"] },
          },
        },
        additionalProperties: false,
      },
    },
    deleted: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
    unchanged: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

type RegisterToolFn = (name: string, entry: ToolEntry) => void;

interface Input {
  repo: string;
  yaml_text: string;
  mode: "install" | "reconcile";
}

interface TaxonomyEntry {
  name: string;
  color: string;
  description?: string;
}

interface DiffReport {
  mode: "install" | "reconcile";
  created: Array<{ name: string }>;
  updated: Array<{ name: string; changes: Array<"color" | "description"> }>;
  deleted: Array<{ name: string }>;
  unchanged: Array<{ name: string }>;
}

interface ListResponse {
  repository: {
    labels: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawLabel[];
    };
  } | null;
}

export function registerLabelSyncFromYamlTool(
  register: RegisterToolFn,
  graphql: GraphqlClient,
): void {
  register("gh.label_sync_from_yaml", {
    description:
      "Apply a canonical-taxonomy YAML to a repo's labels. " +
      "`install` creates missing labels only; `reconcile` also " +
      "updates changed and deletes missing. Returns a diff report " +
      "describing what changed; idempotent in reconcile mode.",
    inputSchema,
    handler: async (raw) => {
      const args = validate<Input>(
        inputSchema,
        raw,
        "gh.label_sync_from_yaml input",
      );
      const coords = parseRepoSlug(args.repo, "gh.label_sync_from_yaml input");
      const taxonomy = parseTaxonomy(args.yaml_text);
      const existing = await loadAllLabels(graphql, coords);

      // Build name → entry maps for O(1) lookup. Names compared
      // case-sensitively because GitHub label names are
      // case-sensitive ("Bug" and "bug" can coexist).
      const taxonomyByName = new Map<string, TaxonomyEntry>();
      for (const e of taxonomy) taxonomyByName.set(e.name, e);
      const existingByName = new Map<string, RawLabel>();
      for (const l of existing) existingByName.set(l.name, l);

      const report: DiffReport = {
        mode: args.mode,
        created: [],
        updated: [],
        deleted: [],
        unchanged: [],
      };

      // 1) Creates: in YAML, not on repo. Both modes do this.
      for (const entry of taxonomy) {
        if (existingByName.has(entry.name)) continue;
        const repositoryId = await lookupRepoNodeId(
          graphql,
          coords,
          "gh.label_sync_from_yaml",
        );
        const input: Record<string, unknown> = {
          repositoryId,
          name: entry.name,
          color: entry.color.toLowerCase(),
        };
        if (entry.description !== undefined) input.description = entry.description;
        await graphql("label/create", { input });
        report.created.push({ name: entry.name });
      }

      // 2) Updates: on both, color or description differs. Only
      //    reconcile mode does this; install leaves existing labels
      //    untouched.
      // 3) Unchanged: on both, equal.
      for (const entry of taxonomy) {
        const onRepo = existingByName.get(entry.name);
        if (!onRepo) continue; // already handled in step 1
        const changes = diffLabel(entry, onRepo);
        if (changes.length === 0) {
          report.unchanged.push({ name: entry.name });
          continue;
        }
        if (args.mode !== "reconcile") {
          // install mode: differing labels stay as-is.
          report.unchanged.push({ name: entry.name });
          continue;
        }
        const input: Record<string, unknown> = { id: onRepo.id };
        if (changes.includes("color")) input.color = entry.color.toLowerCase();
        if (changes.includes("description")) {
          input.description = entry.description ?? "";
        }
        await graphql("label/edit", { input });
        report.updated.push({ name: entry.name, changes });
      }

      // 4) Deletes: on repo, not in YAML. Only reconcile mode.
      if (args.mode === "reconcile") {
        for (const onRepo of existing) {
          if (taxonomyByName.has(onRepo.name)) continue;
          await graphql("label/delete", { input: { id: onRepo.id } });
          report.deleted.push({ name: onRepo.name });
        }
      }

      return validate<DiffReport>(
        outputSchema,
        report,
        "gh.label_sync_from_yaml output",
      );
    },
  });
}

// Parse the YAML, accept either top-level array or `{ labels: [...] }`,
// then validate against the taxonomy schema. Throws structured
// errors on malformed YAML or schema mismatch — both are surfaced
// to the caller as `gh.label_sync_from_yaml input` errors so the
// failure points at the YAML rather than internal state.
function parseTaxonomy(yamlText: string): TaxonomyEntry[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `mcp-github: gh.label_sync_from_yaml input: yaml parse failed: ${msg}`,
    );
  }
  // Tolerate both shapes. The `labels:` key form lets the YAML
  // carry comments / metadata at the top level without polluting
  // the taxonomy entries.
  let entries: unknown;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { labels?: unknown }).labels)
  ) {
    entries = (parsed as { labels: unknown[] }).labels;
  } else {
    throw new Error(
      `mcp-github: gh.label_sync_from_yaml input: yaml must be a top-level array of labels or an object with a 'labels' array`,
    );
  }
  return validate<TaxonomyEntry[]>(
    taxonomySchema,
    entries,
    "gh.label_sync_from_yaml taxonomy",
  );
}

// Walk the repo's full label list across every page. Drives a
// `pageInfo.hasNextPage` loop with `after: endCursor` until the
// API reports no more results, or until the accumulated set
// exceeds `LABELS_TOTAL_CEILING` (safety guard for a runaway
// cursor — a real taxonomy never approaches that count).
async function loadAllLabels(
  graphql: GraphqlClient,
  coords: { owner: string; name: string },
): Promise<RawLabel[]> {
  const all: RawLabel[] = [];
  let cursor: string | null = null;
  // Safety bound: even at LABELS_PAGE_SIZE per call, this is far
  // more iterations than any realistic taxonomy needs. The
  // ceiling-check inside the loop is the primary guard; this
  // for-loop bound is the secondary backstop in case the API
  // reports hasNextPage forever with no advancing cursor.
  const MAX_PAGES = Math.ceil(LABELS_TOTAL_CEILING / LABELS_PAGE_SIZE) + 1;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: ListResponse = await graphql<ListResponse>("label/list", {
      owner: coords.owner,
      name: coords.name,
      first: LABELS_PAGE_SIZE,
      after: cursor,
    });
    if (!data.repository) {
      throw new Error(
        `mcp-github: gh.label_sync_from_yaml: repository '${coords.owner}/${coords.name}' not found or token lacks read access`,
      );
    }
    all.push(...data.repository.labels.nodes);
    if (all.length > LABELS_TOTAL_CEILING) {
      throw new Error(
        `mcp-github: gh.label_sync_from_yaml: repository '${coords.owner}/${coords.name}' exceeded the ${LABELS_TOTAL_CEILING}-label safety ceiling; ` +
          `aborting to avoid a runaway pagination loop. Investigate upstream before retrying.`,
      );
    }
    if (!data.repository.labels.pageInfo.hasNextPage) {
      return all;
    }
    const next: string | null = data.repository.labels.pageInfo.endCursor;
    if (typeof next !== "string" || next === cursor) {
      // Defensive: an API quirk where hasNextPage is true but
      // endCursor doesn't advance would otherwise loop until the
      // backstop. Throw early with a clear signal instead.
      throw new Error(
        `mcp-github: gh.label_sync_from_yaml: pagination stalled (hasNextPage: true but endCursor did not advance) on '${coords.owner}/${coords.name}'`,
      );
    }
    cursor = next;
  }
  throw new Error(
    `mcp-github: gh.label_sync_from_yaml: pagination did not terminate within ${MAX_PAGES} pages on '${coords.owner}/${coords.name}'`,
  );
}

function diffLabel(
  taxonomy: TaxonomyEntry,
  existing: RawLabel,
): Array<"color" | "description"> {
  const changes: Array<"color" | "description"> = [];
  if (existing.color.toLowerCase() !== taxonomy.color.toLowerCase()) {
    changes.push("color");
  }
  // Treat undefined and empty string as equivalent on the YAML
  // side (the schema allows omitting `description`); GitHub
  // returns `null` or `""` interchangeably for "no description".
  const taxDesc = taxonomy.description ?? "";
  const repoDesc = existing.description ?? "";
  if (taxDesc !== repoDesc) {
    changes.push("description");
  }
  return changes;
}
