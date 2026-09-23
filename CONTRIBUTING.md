# Contributing to symbol-mcp-server

Thanks for your interest. Bug reports and feature requests go through the issue forms; security
problems go through private vulnerability reporting (see [`SECURITY.md`](SECURITY.md)), never a
public issue. Pull requests are welcome; for anything larger than a fix, open an issue first so the
question the change answers can be agreed on.

## Development setup

- **Node.js 22 or newer.** With [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.
- **Install from the lockfile, without install scripts:**

  ```sh
  git clone https://github.com/inotakeh/symbol-mcp-server.git
  cd symbol-mcp-server
  npm ci --ignore-scripts
  ```

  The repository's `.npmrc` also sets `ignore-scripts=true`. Adding a dependency needs a
  maintainer's approval; say in the issue or PR which package, why, and who maintains it.

## Build and test

```sh
npm run lint        # biome
npm run typecheck   # tsc --noEmit
npm test            # vitest: unit, tool-layer (in-process MCP client) and evals
npm run build       # tsc -> dist/
```

Run `npm run lint && npm run typecheck && npm test` before every commit; CI runs the same on
Node 22 and 24.

Manual checks against a real node:

```sh
npm run build
npx @modelcontextprotocol/inspector -e SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<testnet-node>:3001 npm test
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<node-host>:3001 SYMBOL_INTEGRATION_ACCOUNT=<address> npm test
```

The Inspector gives the server it starts only a few of its own environment variables (`PATH`,
`HOME` and the like, the MCP SDK's default) plus the ones it is given, so a variable set in front of
`npx` does not reach the server. Pass each one with `-e KEY=VALUE` as above, or enter it in the
Inspector's form; on macOS and Linux, wrapping the server command in `env` works too. Public nodes
for these checks are listed at https://nodewatch.symbol.tools/.

The integration tests (`test/integration/`) only run with `SYMBOL_INTEGRATION=1` and never in CI.
They treat the node as a read-only REST endpoint.

## Test fixtures

The tool-layer tests serve JSON from `test/fixtures/` through a fake `fetch`. Fixtures may contain
**synthetic values only** for anything that identifies a person or an operator: no real account
addresses, public keys, node hosts or friendly names. Public chain data that identifies nobody
(network properties, the XYM mosaic, block heights) can stay verbatim. How each file was made and
which values were replaced is recorded in [`test/fixtures/README.md`](test/fixtures/README.md);
follow the same rules and add a row there for a new file. Synthetic keys and hashes come from
`H("fixture:<label>")` in `test/tools/harness.ts`.

## Adding a tool

Tools answer a question a person asks; they do not mirror one REST endpoint each.

1. Add `src/tools/symbol_<resource>_<action>.ts`, one tool per file, with a `title`, a
   `description`, explicit `annotations` (`readOnlyHint: true`), an `inputSchema` (`z.object`, every
   argument `.describe()`d) and an `outputSchema`. The result is `structuredContent` plus the same
   JSON as text, and its first field is `summary`. Put pure logic in `src/domain/` with unit tests.
2. Register it by **appending** it to `TOOLS` in `src/server.ts`. Never reorder: `tools/list` must
   stay deterministic.
3. Add tests: unit tests for the domain logic, and tool-layer tests in `test/tools/` (output schema,
   error results with a hint, no request to any host other than `SYMBOL_NODE_URL`). Add the tool to
   the smoke calls in `test/tools/harness.ts`.
4. Update the documentation:
   - `README.md` **and** `README.ja.md`: the tool table and an example question;
   - `evals/cases.json`: at least one case (the evals test fails if a registered tool has none);
   - `docs/DESIGN-BRIEF.md` §5.2: the specification;
   - `CHANGELOG.md` under `[Unreleased]`.

## Design rules

The full design is in [`docs/DESIGN-BRIEF.md`](docs/DESIGN-BRIEF.md) (Japanese). In short:

- **Read-only.** No argument accepts a private key, mnemonic or token; nothing is signed or
  announced. The only disk write is `symbol_harvester_watch`'s snapshot under `SYMBOL_STATE_DIR`.
- **Fixed destinations.** Requests go to `SYMBOL_NODE_URL` and, for the comparison tools,
  `SYMBOL_REFERENCE_NODES` only. Tools never take a URL as an argument. No telemetry.
- **The server does the arithmetic.** Amounts, totals, shares and dates are computed on the server
  (amounts as `BigInt`, never floating point) and returned both with divisibility applied and as raw
  integers, so the model never has to add, multiply or round.
- **Chain strings are untrusted.** Transfer messages, friendly names and namespace names are written
  by third parties: sanitize them and expose them under names that say so (`messageText`).
- **Network constants come from `/network/properties`** at run time. Only the generation hash seed
  table is hard-coded.
- **Errors are results, not exceptions**: `isError: true` with a recovery hint, never a stack trace
  or a raw HTTP body. Log with `console.error` only; stdout is the protocol channel.

## Commits and pull requests

- Work on a branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`); `main` is protected.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `test:`,
  `docs:`, `chore:`.
- Keep pull requests small. Fill in the template: what changes, how you verified it (commands and
  results), and the checklist.
- Releases are cut by maintainers: they bump the version and create the tag, and the release
  workflow publishes to npm after an approval. Do not bump versions or create tags in a PR. The
  steps are in [`docs/RELEASING.md`](docs/RELEASING.md).

## Building the Claude Desktop bundle (.mcpb)

The release workflow builds `symbol-mcp-server-<version>.mcpb` from the published npm tarball; you
normally do not need to. To build one locally, check out the commit of that release (the lockfile
must match the version) and run:

```sh
bash scripts/release-assets.sh 0.7.1 /tmp/a          # tarball as npm serves it, checked
bash scripts/build-mcpb.sh 0.7.1 /tmp/a/symbol-mcp-server-0.7.1.tgz /tmp/a
```

The bundle is a plain zip (`manifest.json`, `icon.png`, `server/` with `dist` and the production
`node_modules`); the `mcpb` CLI is not used. `mcpb/manifest.json` is the template: the build writes
the release version and declares the tools and prompts from the packaged server
(`scripts/mcpb-manifest.mjs`), so a new tool needs no manifest edit. `mcpb/icon.png` is drawn by
`node scripts/make-icon.mjs mcpb/icon.png`. Install the result in Claude Desktop (Settings →
Extensions) to try it.

## Files for AI agents

This repository is also developed with AI coding agents. Human contributors can skip this section.

- [`AGENTS.md`](AGENTS.md) holds the instructions shared by agents such as Codex and Claude Code.
  [`CLAUDE.md`](CLAUDE.md) only imports it.
- `.claude/` holds Claude Code's hooks and permission settings. They are guardrails that keep an
  agent away from protected files, credentials and outbound network access.
  [`GUARDRAILS.md`](GUARDRAILS.md) (Japanese) describes the model in detail. The hooks are
  Python 3 scripts, so running Claude Code in this repository needs `python3` on `PATH`. Building,
  testing and sending a pull request by hand need none of these files.
- These files, `.github/workflows/`, `SECURITY.md`, `server.json`, `LICENSE` and the lockfile are
  edited by maintainers only.
