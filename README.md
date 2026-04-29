# @ctxr/mcp-github

GraphQL-first GitHub MCP server. Replaces `gh` CLI shell-outs in [`@ctxr`
agent bundles](https://github.com/ctxr-dev/agent-staff-engineer) with
structured tool calls that run over the standard MCP stdio transport.

The long-term design uses GitHub's GraphQL API exclusively. A planned
`pr_request_reviews` tool (lands in a later MCP-* PR) will call
`requestReviews(input: { pullRequestId, userIds, teamIds })`, which can
request reviews from bot accounts (Copilot, Dependabot, custom apps)
where the REST `RequestReviewers` endpoint silently no-ops. Closing that
gap is the original reason this server exists. The current v0.1 boot
intentionally registers zero tools; tools land PR by PR.

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

Planned auth behaviour (lands in MCP-2): the server will resolve the
token from `GITHUB_TOKEN`, then `GH_TOKEN`, then
`GITHUB_PERSONAL_ACCESS_TOKEN` (matching `gh` CLI fallback order). At
v0.1 bootstrap the server starts cleanly without auth and lists zero
tools.

## Tool reference

The full tool list with input schemas, output shapes, and examples will
live at `docs/tool-reference.md` once MCP-13 lands. At v0.1 the file is
not yet present: tools land PR by PR, and the reference is generated
once the surface stabilises.

## Develop

```sh
npm install
npm run lint    # tsc --noEmit
npm run build   # tsc + post-build (write dist/server.mjs shim → ./server.js + chmod +x)
npm test        # node --test on tests/unit/**/*.test.ts
```

## License

MIT. See [`LICENSE`](./LICENSE).
