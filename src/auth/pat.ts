// src/auth/pat.ts
//
// Resolve a GitHub Personal Access Token from the environment, walking
// the same fallback chain `gh` CLI uses. Centralised here so every
// caller (server start, tests, manual scripts) hits the same precedence
// rules and the same structured-miss error.

const ENV_VARS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
] as const;

export type PatEnvVar = (typeof ENV_VARS)[number];

// Exposed as a constant so tests can iterate the canonical list rather
// than redeclaring it. Object.freeze prevents callers from mutating
// the array at runtime: the `readonly` annotation is only a
// TypeScript-level guarantee, easily defeated by `as any` in JS code,
// so we belt-and-brace it.
export const PAT_ENV_VARS: readonly PatEnvVar[] = Object.freeze([...ENV_VARS]);

export class MissingPatError extends Error {
  override readonly name = "MissingPatError";
  readonly checkedEnv: readonly PatEnvVar[];
  constructor(checked: readonly PatEnvVar[] = ENV_VARS) {
    super(
      `mcp-github: no GitHub token found in environment. ` +
        `Set one of: ${checked.join(", ")}.`,
    );
    this.checkedEnv = checked;
  }
}

// `env` is parameterised (defaulting to `process.env`) so unit tests can
// inject a synthetic environment without mutating real `process.env`,
// which is fragile in parallel test runners.
//
// We trim the raw env value before checking emptiness: a value of
// "   " (whitespace only) is almost certainly a misconfigured CI
// secret rather than a real token, and accepting it would surface as
// a confusing 401 from GitHub later. Treat whitespace-only as unset
// and fall through to the next env var, the same as missing/empty.
export function resolvePat(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ENV_VARS) {
    const v = env[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  throw new MissingPatError();
}
