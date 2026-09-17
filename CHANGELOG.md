# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Node.js 22 or newer is required (`engines.node` is `>=22`). Node.js 20 reached end of life; CI
  runs on Node.js 22 and 24.
- The test runner is vitest 5 (development only; it needs Node.js 22.12 or newer). No test or
  configuration change was needed and no tool behavior changed.

## [0.3.0] - 2026-09-17

### Added

- `symbol_harvester_watch`: did the delegated harvesters unlocked on the configured node increase
  or decrease since the last call. Added and removed remote keys, count delta, and min / max /
  average over the snapshots of the last 30 days. Snapshots (public keys, heights and times only)
  are kept in one file per node under the new optional `SYMBOL_STATE_DIR` (absolute path; created
  on first save with mode 0700, file 0600, written through a temporary file and a rename, never
  through a symlink or outside the directory); the newest 60 are kept. Without the variable the
  tool reports the current list and says no comparison is possible. Modes `compare` (read only),
  `compare_and_save` (default) and `save_only`. A corrupt file or one written for another node
  key becomes a baseline with a note; a write failure is a note in `compare_and_save` and an error
  in `save_only`. Registered after `symbol_version_drift`.
- `SYMBOL_STATE_DIR` environment variable (optional, documented by `--help`).
- `symbol_node_health`: is the configured node running healthily right now. Six checks in a
  fixed order, each ok / warn / fail / unknown with a hint: API node and database status from
  `/node/health` (a 503 answer carries the same body and is read, not treated as a failure), node
  database block count versus chain height (tolerance: one minute of blocks), node clock versus
  the local clock (warn at half a block time, fail at a whole one), finalization lag in blocks and
  minutes (warn at half an epoch, fail at a whole one) and the node roles. Verdict `healthy`,
  `degraded` (a warning, or a check that could not be made because an endpoint failed) or
  `unhealthy`. Every threshold is derived from `/network/properties`. Registered after
  `symbol_delegation_diagnose`.
- `symbol_version_drift`: is the node's software version behind the network majority. The
  versions of the peers the node knows (`/node/peers`, validated entry by entry) and of the
  reference nodes in `SYMBOL_REFERENCE_NODES` (same network only) are counted into a
  distribution; versions are compared component-wise, ties go to the newer version. Verdict `ok`
  (same as or newer than the majority), `behind` (older than the majority, or newer versions hold
  at least half the sample), `far_behind` (newer versions hold 75% or more: peers may start
  refusing connections) or `unknown` (no peers). The REST version from `/node/server` is reported
  alongside. Peer hosts, names and public keys are never part of the output. Registered after
  `symbol_node_health`.
- `RestClient.get` takes an `acceptStatuses` option so a documented non-2xx answer (the 503 of
  `/node/health`) is parsed instead of becoming an error.

### Changed

- The `monthly_health_check` prompt compares the unlocked harvesters with the previous snapshot
  through `symbol_harvester_watch` instead of asking the operator for last month's number;
  `symbol_harvesting_status` is called only on request. The server instructions route "did
  delegators increase or decrease" to the new tool.
- The `monthly_health_check` prompt calls `symbol_node_health` and `symbol_version_drift` right
  after `symbol_node_status` and puts an unhealthy or behind verdict at the top of the report; the
  server instructions route "is the node healthy" and "is its version behind" to the new tools.
- The `peers.json` test fixture is now fully synthetic (six peers with derived keys and a version
  mix); the version comments in the tool registration list name the release that shipped each tool.

### Fixed

- `symbol_node_status` reads the body of a 503 `/node/health` answer (a service is down) instead of
  failing the whole call with an HTTP error.
- DESIGN-BRIEF release labels: the features it marked "0.3.0 / 0.4.0 で追加" shipped in 0.2.0.

## [0.2.0] - 2026-09-16

### Changed

- Every `account` argument (and the `address` of `symbol_transaction_search`, the `value` of
  `symbol_address_parse`) also accepts a namespace name such as `alice` or `alice.pay`. The name
  is resolved through the node to the namespace's address alias before the tool runs: a 39-character
  base32 string is an address only when its checksum verifies, otherwise a lower-case one is tried
  as a name; a missing, expired, mosaic-aliased or alias-less namespace is an error with a hint.
  The resolution is reported in a new nullable `accountResolution` field (`input`, `namespace`,
  `namespaceId`, `address`) and as `alice → NCV5…` at the start of the summary; results for
  addresses and public keys are unchanged apart from `accountResolution: null`.
  `symbol_address_parse` gains `kind: "namespace"` (the only form that contacts the node).
  `GET /namespaces/{id}` answers are cached per process for one `blockGenerationTargetTime`.

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

[Unreleased]: https://github.com/inotakeh/symbol-mcp-server/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/inotakeh/symbol-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/inotakeh/symbol-mcp-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/inotakeh/symbol-mcp-server/releases/tag/v0.1.0
