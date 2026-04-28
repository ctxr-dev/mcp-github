# @ctxr/mcp-github

GraphQL-first GitHub MCP server. Replaces `gh` CLI shell-outs in [`@ctxr`
agent bundles](https://github.com/ctxr-dev/agent-staff-engineer) with
structured tool calls that run over the standard MCP stdio transport.

The server uses GitHub's GraphQL API exclusively. The `pr_request_reviews`
tool calls `requestReviews(input: { pullRequestId, userIds, teamIds })`,
which actually requests reviews from bot accounts (Copilot, Dependabot,
custom apps) where the REST `RequestReviewers` endpoint silently no-ops.
Closing that gap is the original reason this server exists.

## Status

**v0.1 in flight.** Tracking issue:
[`@ctxr/mcp-github` v0.1 roadmap](https://github.com/ctxr-dev/mcp-github/issues/1).

Currently the server starts cleanly and lists zero tools; PR-by-PR
issues `MCP-1` through `MCP-14` add the auth layer, GraphQL client,
tool surface (issue / PR / label / repo / workflow / project ops), error
handling, tests, docs, and the npm release pipeline.

## Install

```sh
# pre-release: install from git
npm install --save-exact ctxr-dev/mcp-github#main
# post-release (after MCP-14):
npm install --save-exact @ctxr/mcp-github
```

## Use as an MCP server

Add to your MCP client's server config:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@ctxr/mcp-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    }
  }
}
```

The server resolves the token from `GITHUB_TOKEN`, then `GH_TOKEN`, then
`GITHUB_PERSONAL_ACCESS_TOKEN` (matching `gh` CLI fallback order).

## Tool reference

The full tool list with input schemas, output shapes, and examples lives
at [`docs/tool-reference.md`](./docs/tool-reference.md) (added by MCP-13).
At v0.1 the placeholder is intentional: tools land PR by PR.

## Develop

```sh
npm install
npm run lint    # tsc --noEmit
npm run build   # tsc + post-build (rename to dist/server.mjs + chmod +x)
npm test        # node --test on tests/unit/**/*.test.ts
```

## License

MIT. See [`LICENSE`](./LICENSE).
