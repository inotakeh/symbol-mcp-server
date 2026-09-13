# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `symbol_delegation_diagnose`: is an account's delegated harvesting active and, if not, where
  does it stop. Eleven checks in a fixed order, each ok / warn / fail / unknown with a hint:
  account exists, balance within `minHarvesterBalance` / `maxHarvesterBalance` (counted in
  `chain.harvestingMosaicId`), importance above zero (or blocks until the next
  `importanceGrouping` recalculation), linked / VRF / node keys, node key equal to the configured
  node's `nodePublicKey`, remote key in `/node/unlockedaccount`, account type, harvested blocks in
  the last `recentDays` (harvester receipts only), and the newest persistent delegation request
  transfer to the node (marker and recipient rule taken from the SDK and catapult sources). Verdict
  `active`, `not_active` (any fail) or `cannot_verify` (a node-side check could not be made, e.g.
  the account delegates to another node; no other host is contacted). The server instructions
  route "is my delegated harvesting working" to it. Registered after
  `symbol_finality_participation`.
- `symbol_harvesting_income`: `granularity: monthly` (one bucket per calendar month in
  `SYMBOL_TIMEZONE` or UTC, summed in the same exact-integer pass as the daily buckets; the summary
  keeps the period total first and adds one line per month) and `output: csv` (the text content
  block becomes an RFC 4180 CSV with one row per day, month or receipt; `structuredContent` stays
  JSON and repeats the CSV in a `csv` field). The daily and receipt outputs are unchanged.
- Cache hints for the 2026-07-28 protocol revision: `tools/list` and `prompts/list` are
  advertised with `ttlMs` of 24 hours and `cacheScope: public`; tool results keep the defaults.
  2025-era responses are unaffected.
- Tool-layer tests run on both protocol eras: the harness now connects with the 2025 `initialize`
  handshake explicitly (the SDK's `auto` mode had been negotiating 2026-07-28 in-process, so the
  2025 path was untested), and a new suite pins the client to 2026-07-28 for listings, prompts,
  tool calls, instructions, cache hints and a smoke call of every tool.
- `symbol_finality_participation`: whether an account's voting key actually signed the
  finalization proof of an epoch (default: the latest finalized one) and optionally the up to 20
  epochs before it, read from `GET /finalization/proof/epoch/{epoch}`. Per epoch: `participated`
  (a registered key is among the root signers of both prevote and precommit), `missed` (with the
  stage that was not signed), `no_active_key` or `unavailable` (the node holds no proof; not an
  error unless every requested epoch is missing), the signature count per stage, and a warning
  when no key covers the current finalization epoch or the current epoch was missed (historical
  epochs never warn). Other voters' keys are never reported. The renewal
  prompt and the server instructions point to it. Registered after `symbol_transaction_status`.
- `symbol_transaction_status`: where 1 to 20 transactions stand right now, from one
  `POST /transactionStatus` call: confirmed (with height), unconfirmed, partial (waiting for
  cosignatures), failed (with the node's code and its meaning from the OpenAPI
  `TransactionStatusEnum`, imported mechanically into `src/domain/txstatus.ts`) or not_found.
  Meant for "did my key link go through?" right after announcing. Registered after the existing
  tools.
- Server `instructions` in the initialize result: read-only contract, account formats, which tool
  answers harvest-income and voting-key questions, and "use the numbers as returned".
- MCP prompts `voting_key_renewal_checklist` and `monthly_health_check` (argument `account`, a
  base32 address): operator checklists that call the tools in a fixed order. Prompt bodies contain
  no real identifiers.
- `symbol_harvesting_income`: totals the harvest rewards (HarvestFee receipts of the network
  currency) an account received in a date range (`fromDate`/`toDate`, resolved to heights by a
  binary search over block timestamps) or a height range. Sums are exact integers (BigInt) and are
  split into harvester / beneficiary / unknown using `harvestBeneficiaryPercentage` and
  `harvestNetworkPercentage` from the node; output is per-day buckets in `SYMBOL_TIMEZONE` (or UTC)
  or a per-receipt list, with a 200-page (20,000 statement) cap reported as `truncated`. Registered
  after the existing tools, so `tools/list` order is unchanged for them.
- Receipt type table (`src/domain/receipttype.ts`, from catbuffer `receipt_type.cats`) and
  `harvestNetworkPercentage` in the parsed network properties.

## [0.1.0] - 2026-09-10

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

[Unreleased]: https://github.com/inotakeh/symbol-mcp-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/inotakeh/symbol-mcp-server/releases/tag/v0.1.0
