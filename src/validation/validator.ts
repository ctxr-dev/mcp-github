// src/validation/validator.ts
//
// Lightweight wrapper around ajv for JSON-Schema validation. Used by
// every tool handler to gate input/output payloads at the boundary
// between the MCP transport and the GraphQL client. The MCP SDK does
// NOT auto-validate `request.params.arguments` against a tool's
// declared `inputSchema` — we have to do it ourselves, otherwise a
// malformed input lands in a handler that crashes on
// `args.someField.someSubfield` rather than returning a clean
// protocol error.
//
// Why ajv: industry-standard, draft-07/2019/2020 support, JIT
// compiles schemas to functions (so per-call validation is cheap
// even with the deeply-nested issue/PR/project shapes we'll be
// validating dozens of times a session). Single-instance, schemas
// compiled lazily and cached by reference.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

// One Ajv instance shared across the process. `strict: false` because
// we use a few non-standard keywords for documentation (`example`,
// `description` on object fields) that ajv would otherwise warn
// about. `allErrors: true` collects every violation so the structured
// error message can list all of them, not just the first one.
//
// `addFormats` registers the standard JSON-Schema formats
// (`date-time`, `email`, `uri`, etc.). Without this call ajv treats
// unknown formats as no-ops under `strict: false`, so a schema
// declaring `format: "date-time"` would silently accept any string.
// We need real format enforcement on inputs like `gh.issue_list`'s
// `since` field.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

// Cache compiled validators by schema-object identity. Schema objects
// are usually module-level constants in the tool files, so the
// WeakMap key is stable and the cache hits on every subsequent call.
const compileCache = new WeakMap<object, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  let v = compileCache.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    compileCache.set(schema, v);
  }
  return v;
}

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError";
  readonly errors: readonly ErrorObject[];
  readonly where: string;
  constructor(where: string, errors: readonly ErrorObject[]) {
    const summary = errors.map(formatError).join("; ");
    super(`mcp-github: ${where}: ${summary}`);
    this.errors = errors;
    this.where = where;
  }
}

// Render one ajv error onto a single line. We pull
// `params.additionalProperty` and `params.allowedValues` into the
// message text because for `additionalProperties` and `enum`
// failures the `instancePath` alone is `<root>` / the field path,
// and the ajv-default `message` ("must NOT have additional
// properties" / "must be equal to one of the allowed values")
// doesn't say which property or which values — leaving the
// message useless without manual cross-referencing.
function formatError(err: ErrorObject): string {
  const at = err.instancePath || "<root>";
  const base = err.message ?? "invalid";
  const params = err.params as Record<string, unknown>;
  const extra: string[] = [];
  if (typeof params["additionalProperty"] === "string") {
    extra.push(`'${params["additionalProperty"]}'`);
  }
  if (Array.isArray(params["allowedValues"])) {
    extra.push(`allowed: ${(params["allowedValues"] as unknown[]).join(", ")}`);
  }
  return extra.length > 0 ? `${at}: ${base} (${extra.join("; ")})` : `${at}: ${base}`;
}

// Validate `data` against `schema`. On success returns the value
// (typed as `T` for caller convenience); on failure throws
// `SchemaValidationError` whose message names the violation site
// (`<root>`, `/title`, `/labels/0`) and the ajv-supplied reason.
//
// `where` is an opaque string included in the error for diagnostics
// (e.g. `"gh.issue_create input"` or `"gh.issue_view output"`); it
// flows straight into the error message.
export function validate<T = unknown>(
  schema: Record<string, unknown>,
  data: unknown,
  where: string,
): T {
  const v = compile(schema);
  const ok = v(data);
  if (!ok) {
    throw new SchemaValidationError(where, v.errors ?? []);
  }
  return data as T;
}
