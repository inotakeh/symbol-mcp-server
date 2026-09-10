# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Initial release candidate (0.1.0).

### Changed

- Documentation examples use placeholder or public nodes, and the account-specific test fixtures
  carry synthetic identities (see `test/fixtures/README.md`).

### Added

- Read-only MCP server (stdio) for the Symbol blockchain, built on `@modelcontextprotocol/server` 2.x
  and Zod 4. Node.js 20 or newer.
- Thirteen task-level tools, registered in a fixed order, each with `readOnlyHint: true`, an
  `outputSchema`, and a result that carries `structuredContent` plus the same JSON as text with a
  `summary` first:
  - General: `symbol_network_info`, `symbol_account_get`, `symbol_transaction_get`,
    `symbol_transaction_search`, `symbol_mosaic_get`, `symbol_namespace_get`, `symbol_fee_estimate`,
    `symbol_address_parse`, `symbol_time_convert`.
  - Node operators: `symbol_node_status`, `symbol_voting_key_status`, `symbol_harvesting_status`,
    `symbol_network_compare`.
- Voting-key expiry planning: status per key (expired/active/future), remaining epochs, blocks and
  days, estimated expiry date from the measured average block time, a 7-to-3-days-before renewal
  window, slot usage including expired keys, and eligibility against `minVoterBalance`.
- Configuration through environment variables only: `SYMBOL_NODE_URL` (required),
  `SYMBOL_NETWORK`, `SYMBOL_TIMEZONE`, `SYMBOL_REFERENCE_NODES`, `SYMBOL_REQUEST_TIMEOUT_MS`.
  Start-up fetches `/node/info`, detects mainnet or testnet from the generation hash seed, and
  refuses to start when `SYMBOL_NETWORK` disagrees with the node.
- Name resolution in output: mosaic ids to aliases (`symbol.xym`), namespace ids to dotted names,
  transaction type codes to names; amounts with divisibility applied and as raw integers; ISO 8601
  UTC timestamps with an optional local time.
- `--help` (environment variable reference) and `--version` flags; both write to stderr so stdout
  stays reserved for JSON-RPC.
- Deterministic evaluation cases in `evals/cases.json` (13 representative questions with the
  expected tool call), checked by `npm test` against the registered tools and their input schemas.
- Unit tests for the domain layer, in-process MCP client tests for every tool with a stubbed node,
  and opt-in live-node integration tests (`SYMBOL_INTEGRATION=1`).
- English and Japanese README, MIT license.

### Security

- No tool accepts, stores, logs or transmits private keys, mnemonics or tokens; no transaction is
  built, signed or announced.
- Tools never take URLs as arguments. The server contacts only `SYMBOL_NODE_URL` and the hosts in
  `SYMBOL_REFERENCE_NODES`; there is no telemetry.
- Strings written by third parties (transfer messages, node friendly names, host names, alias names)
  are exposed under explicitly named fields such as `messageText`, stripped of control and bidi
  characters, and length-capped.
- Errors are returned as `isError` results with a recovery hint; stack traces and raw HTTP bodies
  never reach the model. Internal errors are logged to stderr only.
- Every request has a timeout, a `User-Agent`, a 5 MB response cap and a concurrency limit of 4,
  and every response is schema-validated before use.

[Unreleased]: https://github.com/inotakeh/symbol-mcp-server/commits/main
