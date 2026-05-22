// src/validation/advertise.ts
//
// Make a tool input schema safe to ADVERTISE to an Anthropic-backed
// MCP client. The Anthropic tool-use API rejects oneOf, allOf, and
// anyOf at the TOP LEVEL of a tool input_schema:
//
//   tools.N.custom.input_schema: input_schema does not support
//   oneOf, allOf, or anyOf at the top level
//
// Several tools here use a top-level oneOf/allOf to pin "exactly one
// call shape" (for example: pass a content URL, or pass repo plus
// number, never both). When an agent is handed the full tool surface
// (Claude Code sub-agents receive every registered tool), advertising
// those schemas makes the API reject the whole request, which silently
// disables Explore and Plan sub-agents in any project that registers
// this server.
//
// The constraint is still enforced at call time: every handler runs
// validate(inputSchema, args, ...) (see validator.ts) with ajv, which
// honours the full schema including the top-level union. Stripping
// only touches the ADVERTISED copy, and only the top level: nested
// unions (such as properties.value.oneOf) are valid and are kept.

const FORBIDDEN_TOP_LEVEL = ["oneOf", "allOf", "anyOf"] as const;

// Return a copy of `schema` with the forbidden top-level keywords
// removed. Does not recurse, and never mutates the input (handlers
// reuse the same schema object for ajv validation). When there is
// nothing to strip, the original object is returned unchanged so the
// common case stays allocation-free and identity-stable.
export function toPublicInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  let cloned: Record<string, unknown> | undefined;
  for (const key of FORBIDDEN_TOP_LEVEL) {
    if (key in schema) {
      cloned ??= { ...schema };
      delete cloned[key];
    }
  }
  return cloned ?? schema;
}
