# symbol-mcp-server

[![npm version](https://img.shields.io/npm/v/symbol-mcp-server)](https://www.npmjs.com/package/symbol-mcp-server)

> **Symbol only.** This server talks to [Symbol](https://docs.symbol.dev/) (catapult) nodes. It does not
> support NEM NIS1 (XEM), which is a separate chain with a different API.
> **Unofficial.** This is an independent project with no affiliation to the NEM or Symbol core teams.

[日本語版 README](README.ja.md)

Read-only [MCP](https://modelcontextprotocol.io/) server that turns the Symbol REST API into 22
task-level tools. Instead of mirroring REST endpoints one-to-one, each tool answers a question a
person actually asks:

- **Account holders:** balances with alias names and decimals applied, transaction history and
  details with decoded messages, mosaic and namespace lookups, fee estimates, address validation,
  height/epoch/time conversion.
- **Node operators:** node health and sync state, delegated-harvesting status, comparison against
  reference nodes, and above all **voting-key expiry**: remaining epochs, blocks and days, the
  estimated expiry date and a recommended renewal window.

Every tool returns `structuredContent` (validated against a published `outputSchema`) plus the same
JSON as text, with a one-to-three-line `summary` first. Amounts are returned both with divisibility
applied and as the raw integer; timestamps are ISO 8601 UTC, with a local time added when
`SYMBOL_TIMEZONE` is set.

## Requirements

- Node.js 22 or newer.
- A Symbol REST node reachable over `https://` (port 3001 on most public nodes). Public nodes are
  listed at https://nodewatch.symbol.tools/.

## Install

**From npm** (recommended):

```sh
npx -y symbol-mcp-server --help
```

Also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.inotakeh/symbol`.

**From source:**

```sh
git clone https://github.com/inotakeh/symbol-mcp-server.git
cd symbol-mcp-server
npm ci
npm run build
SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
```

`node dist/index.js --help` prints the environment variables to stderr and exits;
`--version` prints the version. The binary takes no other flags: everything is configured through
the environment, so a model can never point it at another host.

## Configure your MCP host

The server speaks MCP over stdio. On start-up it fetches `/node/info`, detects mainnet or testnet
from the generation hash seed, and logs one line to stderr:

```
symbol-mcp-server 0.5.0: mainnet via <node-host>:3001, timezone Asia/Tokyo
```

### Claude Desktop

Add to `claude_desktop_config.json`. With the npm package:

```json
{
  "mcpServers": {
    "symbol": {
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": {
        "SYMBOL_NODE_URL": "https://<node-host>:3001",
        "SYMBOL_TIMEZONE": "Asia/Tokyo"
      }
    }
  }
}
```

From a source checkout:

```json
{
  "mcpServers": {
    "symbol": {
      "command": "node",
      "args": ["/path/to/symbol-mcp-server/dist/index.js"],
      "env": {
        "SYMBOL_NODE_URL": "https://<node-host>:3001"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add symbol -s user -e SYMBOL_NODE_URL=https://<node-host>:3001 -e SYMBOL_TIMEZONE=Asia/Tokyo -- npx -y symbol-mcp-server
# or, from a source checkout:
claude mcp add symbol -s user -e SYMBOL_NODE_URL=https://<node-host>:3001 -- node /path/to/symbol-mcp-server/dist/index.js
```

Or commit a project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "symbol": {
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": { "SYMBOL_NODE_URL": "https://<node-host>:3001" }
    }
  }
}
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `SYMBOL_NODE_URL` | yes | REST URL of the node to query, e.g. `https://<node-host>:3001`. `https://` is required (`http://` only for `localhost` / `127.0.0.1`). The port is used exactly as given. |
| `SYMBOL_NETWORK` | no | `mainnet` or `testnet`. When set, start-up fails if the node reports a different network. |
| `SYMBOL_TIMEZONE` | no | IANA zone such as `Asia/Tokyo`. Adds a local time next to every UTC timestamp. |
| `SYMBOL_REFERENCE_NODES` | no | Comma-separated `https://` node URLs that `symbol_network_compare` and `symbol_version_drift` check against. No other host is ever contacted. |
| `SYMBOL_REQUEST_TIMEOUT_MS` | no | Per-request timeout, 100 to 600000. Default `10000`. |
| `SYMBOL_STATE_DIR` | no | Absolute directory where `symbol_harvester_watch` keeps one snapshot file per node (unlocked harvester public keys, heights and times; no secrets). Created on first save with mode 0700. Unset: the tool reports the current list without a comparison. |

## Tools

All 22 tools are read-only (`readOnlyHint: true`) and are listed in a fixed order. Arguments are
identifiers only, never URLs. Every `account` argument (and the `address` of
`symbol_transaction_search`) takes a base32 address, a hex public key, or a namespace name such as
`alice` or `alice.pay` that carries an address alias; the resolution is reported in
`accountResolution` and at the start of the summary.

| Tool | Arguments | Answers |
|---|---|---|
| `symbol_network_info` | none | Network name/identifier and generation hash seed, current and finalized height, finalization epoch, block target time, voting set grouping, epoch adjustment, XYM mosaic id/alias/divisibility, current fee multipliers. |
| `symbol_node_status` | none | Friendly name, host, roles (Peer/API/Voting), decoded version, health of API node and database, heights, peer count, and a sync check (latest block older than 5 minutes means `synced: false`). |
| `symbol_account_get` | `account` (address, public key or namespace name), `format` | Address in base32 and hex, public key, every mosaic balance with alias and decimals, importance, linked/VRF/node/voting keys, whether delegated harvesting is set up, multisig settings. |
| `symbol_voting_key_status` | `account` | Every voting key with status (expired/active/future), remaining epochs/blocks/days, estimated expiry date, recommended renewal window (7 to 3 days before), slot usage including expired keys, voter eligibility versus `minVoterBalance`, warnings. |
| `symbol_transaction_get` | `transactionHash` | Looks in confirmed, unconfirmed and partial groups and reports the status; type name, signer and recipient, mosaics with aliases, decoded plain message or "encrypted" marker, fee, height and time, inner transactions of aggregates. |
| `symbol_transaction_search` | `address`, `type`, `pageSize`, `pageNumber`, `order`, `format` | Confirmed transactions involving an account, newest first by default, optional type filter by name (`transfer`) or code (`16724`), 10 to 100 per page. |
| `symbol_mosaic_get` | `mosaic` (hex id or alias such as `symbol.xym`) | Supply, divisibility, flags (supply mutable, transferable, restrictable, revokable), owner, start height, duration and estimated expiry. |
| `symbol_namespace_get` | `namespace` (name or hex id) | Owner, root or sub, level names, alias target (address or mosaic), start and end height, estimated expiry date. |
| `symbol_fee_estimate` | `transactionSizeBytes` (optional) | Slow/average/median/fast fee tiers in XYM computed from the node's current multipliers. Nothing is signed or sent. |
| `symbol_address_parse` | `value` (address, public key or namespace name) | Offline validation: checksum, network byte, base32/hex/dashed forms, and the addresses derived from a public key. A namespace name is resolved through the node to its address alias. |
| `symbol_time_convert` | one of `height`, `epoch`, `timestamp` | Height, finalization epoch, network timestamp and wall-clock time. Exact for the past, estimated (and flagged) for the future. |
| `symbol_harvesting_status` | `account` (optional) | Unlocked delegated harvesters on the node, harvesting limits and beneficiary percentage, and whether the given account's linked key is unlocked here. |
| `symbol_network_compare` | none | Height and finalization of the node versus `SYMBOL_REFERENCE_NODES`, blocks behind the best, `lagging` flags. Explains what to do when no reference nodes are configured. |
| `symbol_harvesting_income` | `account`, `fromDate` + `toDate` or `fromHeight` + `toHeight`, `granularity`, `format` | Harvest rewards received in the period: receipt count and exact XYM total (summed on the server as integers), harvester / beneficiary / unknown split, per-day buckets in `SYMBOL_TIMEZONE` or UTC, or a list of receipts. Dates are resolved to heights from block timestamps. `granularity: monthly` gives one row per calendar month (yearly questions); `output: csv` returns the rows as CSV text for a spreadsheet while the JSON stays available. A year or more in one call is fine: the range is read in chunks of about 90 days (`fetch` reports chunks, retries and pages). |
| `symbol_transaction_status` | `transactionHashes` (array, 1 to 20) | Where each transaction stands right now: confirmed (with height), unconfirmed, partial (waiting for cosignatures), failed (with the node's code and its meaning) or not_found. One request for the whole batch. |
| `symbol_finality_participation` | `account`, `epoch` (optional, default latest finalized), `epochs` (1 to 20, default 1), `format` | Whether the account's voting key actually signed the finalization proof of each epoch: participated (both prevote and precommit), missed (which stage was not signed), no_active_key or unavailable, with the signature count per stage (a stage that the proof splits into several message groups counts as one stage; a signature in any of its groups counts) and a warning when no key covers the current epoch or the current epoch was missed (historical epochs never warn). |
| `symbol_delegation_diagnose` | `account`, `recentDays` (1 to 30, default 7), `format` | Is delegated harvesting active, and if not, where does it stop: account exists, balance within the harvesting limits, importance above zero (or blocks until the next recalculation), linked/VRF/node keys, node key equal to the configured node's `nodePublicKey`, remote key unlocked on that node, account type, harvested blocks in the last N days, and the persistent delegation request transfer to the node. Verdict `active`, `not_active` or `cannot_verify` (delegation to another node cannot be checked from here). |
| `symbol_node_health` | `format` | Is the configured node running healthily right now: API node and database status (a 503 `/node/health` answer is read, not treated as a failure), database block count versus chain height, node clock versus this machine's clock, finalization lag in blocks and minutes, and roles. Six checks in a fixed order, each ok/warn/fail/unknown with a hint; verdict `healthy`, `degraded` (a warning or a check that could not be made) or `unhealthy`. Thresholds derive from the network properties. Complements `symbol_node_status`. |
| `symbol_version_drift` | `format` | Is the node's software version behind the network majority: versions of the peers the node knows plus the reference nodes, as a distribution with the majority version and the share running something newer. Verdict `ok`, `behind` (older than the majority, or newer versions hold at least half the sample), `far_behind` (75% or more newer: peers may refuse connections) or `unknown` (no peers). Peer hosts and keys are never reported. |
| `symbol_harvester_watch` | `mode` (`compare`, `compare_and_save`, `save_only`), `format` | Did the delegated harvesters unlocked on the node increase or decrease since the last call: added and removed remote keys, count delta, and min / max / average over the snapshots of the last 30 days. Snapshots are kept in one file per node under `SYMBOL_STATE_DIR`; without it the current list is reported and no comparison is possible. `compare` reads only, `compare_and_save` (default) also stores the current list, `save_only` stores without comparing. |
| `symbol_account_rank` | `account` (optional), `mosaic` (optional; hex id or alias, default XYM), `top` (1 to 100, default 20), `maxRank` (100 to 5000, default 1000), `format` | Where an account ranks among the holders of a mosaic and who the top holders are, like an explorer rich list: the account's balance, share of supply (4 decimals, integer arithmetic) and rank, the top N holders with balances and shares, and the combined top-N share. Holders are read from `GET /accounts?orderBy=balance` 100 per request, one request at a time, until the account is found or `maxRank` is reached (`rankBeyond` then says so). Omit `account` for the top list only. Ties are ordered by the node; no labels (exchange, foundation) are attached. |
| `symbol_holdings_value` | `account`, `unitPrice` (decimal string, e.g. `"12.34"`), `currency` (3 to 6 upper-case letters), `priceSource` (optional), `priceAsOf` (optional), `mosaic` (optional, default XYM), `format` | What the account's balance of a mosaic is worth at a unit price **the caller supplies**: the balance, the normalised price, the exact product and the product rounded to the currency's customary decimals (0 for JPY and KRW, otherwise 2), all in integer arithmetic. The server never fetches or checks prices; `priceSource` and `priceAsOf` are echoed so the answer states where the number came from. Not a tax computation: no fees, spread or taxes. |

### Example questions

**"When does the voting key of NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY expire, and when should I renew it?"**
→ `symbol_voting_key_status { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY" }`
Returns each key's `startEpoch`/`endEpoch`, the expiry height `(endEpoch - 1) × votingSetGrouping`,
remaining epochs, blocks and days, an estimated expiry date based on the measured average block
time, the renewal window, free slots (expired keys still occupy slots) and whether the balance
meets `minVoterBalance`.

**"Show me alice's account."**
→ `symbol_account_get { "account": "alice" }`
The namespace `alice` is resolved through the node to its address alias (a missing, expired,
mosaic-aliased or alias-less namespace is an error with a hint); the answer starts with
`alice → NCV5…` and carries the resolution in `accountResolution`. Works for every account argument.

**"How much XYM does NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY hold?"**
→ `symbol_account_get { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY" }`
Returns every mosaic with `alias` (`symbol.xym`), `amount` (decimals applied) and `rawAmount`.

**"Show the last 20 transfers involving that account, then the details of the newest one."**
→ `symbol_transaction_search { "address": "NCV5HR…", "type": "transfer", "pageSize": 20 }`
→ `symbol_transaction_get { "transactionHash": "<hash from the list>" }`
The list gives hashes, dates, counterparties and message previews; the second call adds fees,
full decoded messages and inner transactions.

**"Is my node behind?"**
→ `symbol_node_status {}` checks the age of the latest block on the configured node;
→ `symbol_network_compare {}` reports how many blocks it trails `SYMBOL_REFERENCE_NODES`.

**"How much did NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY earn from harvesting in August 2026?"**
→ `symbol_harvesting_income { "account": "NCV5HR…", "fromDate": "2026-08-01", "toDate": "2026-08-31" }`
Resolves the dates to block heights, reads every HarvestFee receipt addressed to the account and
sums them as exact integers: total XYM, harvester versus beneficiary share, and one row per day.
Nothing is left for the model to add up.

**"I just announced my voting key link. Did transaction FAEEB042… go through?"**
→ `symbol_transaction_status { "transactionHashes": ["FAEEB042…"] }`
Answers confirmed (with the height), unconfirmed, partial (aggregate bonded waiting for
cosignatures), failed (with the node's code such as `Failure_Core_Insufficient_Balance` and its
meaning) or not_found. Always an array, up to 20 hashes per call.

**"Was my voting node NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY actually able to vote last week?"**
→ `symbol_finality_participation { "account": "NCV5HR…", "epochs": 14 }`
Reads the finalization proof of the latest finalized epoch and the 13 before it (an epoch is
`votingSetGrouping` blocks, about 12 hours on mainnet) and reports per epoch whether one of the
account's voting keys is among the signers of both stages, how many voters signed, and a warning
if the current epoch was missed or no key covers it.

**"I think my delegated harvesting is not working. Have a look at NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY."**
→ `symbol_delegation_diagnose { "account": "NCV5HR…" }`
Runs eleven checks in a fixed order (existence, balance limits, importance, the three key links, node
key versus the configured node, unlocked on that node, account type, recent harvested blocks, the
delegation request transfer) and answers `active`, `not_active` (with the failing step and a hint) or
`cannot_verify` (the account delegates to a node other than `SYMBOL_NODE_URL`, so the node side cannot
be checked).

**"Is my node healthy, and is its version behind?"**
→ `symbol_node_health {}` checks the API node, database, storage, clock and finalization lag of the
configured node and answers healthy / degraded / unhealthy with the failing checks;
→ `symbol_version_drift {}` compares the node version with its peers and the reference nodes and
answers ok / behind / far_behind. Both are the first things to look at after a node OS migration.

**"Have my delegators come back after the migration?"**
→ `symbol_harvester_watch {}` compares the harvesters unlocked on the node right now with the last
stored snapshot (added and removed keys, count delta, 30-day min / max / average) and stores today's
list for the next check. Needs `SYMBOL_STATE_DIR`; without it the tool reports the current count and
says no comparison is possible.

**"Where does NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY rank by XYM holdings? Who are the top 10?"**
→ `symbol_account_rank { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY", "top": 10 }`
Reads the holder list ordered by balance 100 accounts at a time until the account turns up (or
`maxRank`, default 1000, is reached), and returns its balance, share of supply and rank together
with the top 10 holders and their combined share. All shares are computed by the server in integer
arithmetic; the top of the list is usually exchanges and the foundation, and the tool labels nobody.

**"If XYM is 12.34 yen, how much are my holdings worth? NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY"**
→ `symbol_holdings_value { "account": "NCV5HR…", "unitPrice": "12.34", "currency": "JPY" }`
Reads the balance and multiplies it by the price in integer arithmetic: `53,321,140 JPY` for
4,321,000 XYM, with the exact product alongside. **The price comes from the caller.** This server
never contacts a price API (it talks to `SYMBOL_NODE_URL` only), so when you ask *"what are my
holdings worth right now?"* the flow in Claude Desktop is: the model looks the price up first (a web
search, another MCP server that serves prices, or you type it in), then calls this tool with
`unitPrice`, `currency` and, ideally, `priceSource` / `priceAsOf` so the answer says where and when
the price was observed. The model is told not to multiply balance by price itself.

More cases, with the exact arguments expected for each, are in [`evals/cases.json`](evals/cases.json).

## Prompts

Two MCP prompts (`prompts/list`) bundle the tool calls a node operator repeats. Both take one
argument, `account`: the 39-character base32 address of the voting / harvesting account. The
prompt text contains no addresses, hosts, keys or dates of its own.

| Prompt | What it walks through |
|---|---|
| `voting_key_renewal_checklist` | `symbol_voting_key_status` (expiry, renewal window, free slots), `symbol_node_status` (stop if not synced), `symbol_network_compare`, then, after the operator has announced the VotingKeyLink outside this server, `symbol_transaction_status` on the hash, a second `symbol_voting_key_status` to confirm the new key, and `symbol_finality_participation` once the new key's start epoch is finalized. Ends with a four-line summary. |
| `monthly_health_check` | `symbol_node_status`, `symbol_node_health` (unhealthy goes first), `symbol_version_drift` (behind or far_behind goes first), `symbol_network_compare`, `symbol_harvester_watch` (delta against the previous snapshot; `symbol_harvesting_status` only on request), `symbol_voting_key_status` (warning first if a key expires within 30 days), `symbol_account_get` (balance versus `minVoterBalance`) and `symbol_harvesting_income` for the previous calendar month. Reports on one screen as Action required / Attention / Normal. |

The server also sends short `instructions` at initialize time (read-only, account formats, which
tool answers harvest-income and voting-key questions, use the returned numbers as they are).

## CLI: monitoring from cron

The same binary has a one-shot `check` subcommand that needs no MCP client. It judges the node with
the tools above, prints one report and exits non-zero when something is wrong:

```
symbol-mcp-server check [--account <address|publicKey|namespace>] [--warn-days <n>]
                        [--format text|json] [--quiet]
```

It reads the same environment variables as the server (`SYMBOL_NODE_URL` is required;
`SYMBOL_TIMEZONE`, `SYMBOL_REFERENCE_NODES` and `SYMBOL_STATE_DIR` are optional) and needs
Node.js 22 or newer. Started without arguments the binary is still the MCP server, unchanged.

| # | Item | ok / warn / fail |
|---|---|---|
| 1 | `node_health` | `symbol_node_health`: healthy / degraded / unhealthy |
| 2 | `version_drift` | `symbol_version_drift`: ok / behind or unknown / far_behind |
| 3 | `harvester_watch` | `symbol_harvester_watch` (compare and save): warn when fewer harvesters are unlocked than at the previous run, or when the snapshot could not be saved. Skipped without `SYMBOL_STATE_DIR` |
| 4 | `voting_key_status` | With `--account`: warn when the active voting key expires within `--warn-days` (default 14, 1 to 120), fail within 3 days or without an active key; ok when a successor key is already registered without a gap. Skipped without `--account` |
| 5 | `finality_participation` | With `--account`, latest finalized epoch: participated / missed or no proof on the node / no key covers the epoch. Skipped without `--account` |

The judgments are the tools' own; the check only reads their output, and the hint printed under a
warn or fail line is the tool's text. A tool that fails (for example an HTTP error) fails its item
and the others still run.

| Exit code | Meaning |
|---|---|
| 0 | every item is ok or skipped |
| 1 | at least one warning, no failure |
| 2 | at least one failure |
| 3 | the check could not run: configuration error, node unreachable, or bad arguments (one or two lines on stderr say why) |

Text output (the default; illustrative values):

```
symbol check: WARN (node.example:3001, mainnet, 2026-01-15T07:00:03+09:00)
[ok] node_health: healthy (finalization lag 12 blocks)
[ok] version_drift: ok. node.example:3001 runs 1.0.3.9; majority of 24 sampled nodes runs 1.0.3.9; 0% run something newer.
[ok] harvester_watch: 18 unlocked harvesters on node.example:3001, unchanged since 2026-01-14T07:00:02+09:00 (2026-01-13T22:00:02.000Z). Snapshot saved (31 stored).
[warn] voting_key_status: active key 0A1B2C3D… expires in about 12.4 days (epoch 4321, estimated 2026-01-27T16:40:00+09:00 (2026-01-27T07:40:00.000Z))
  hint: Active voting key 0A1B2C3D… expires at epoch 4321 in about 12.4 days (...) and no successor key is registered.
[ok] finality_participation: epoch 4290: participated (signed prevote and precommit)
```

`--format json` prints the same report as one JSON document: `{ verdict, exitCode, node: { host,
network }, checkedAt, checks: [{ id, status, detail, hint }], warnDays, account }`, with `verdict`
one of `ok`, `warn`, `fail`, `error` (exit code 3) and `account` the resolved address. `--quiet`
prints nothing when the exit code is 0, so cron only mails when there is something to read:

```
MAILTO=you@example.com
0 7 * * * SYMBOL_NODE_URL=https://node.example:3001 SYMBOL_STATE_DIR=/var/lib/symbol-mcp-server \
  npx --yes symbol-mcp-server check --account NXXX... --warn-days 14 --quiet
```

- **The check sends no notification.** It writes to stdout and stderr and sets the exit code; mail
  is cron's job (`MAILTO`). It contacts `SYMBOL_NODE_URL` and the `SYMBOL_REFERENCE_NODES`, nothing
  else, and is as read-only as the server. With `SYMBOL_STATE_DIR` set, every run appends one
  snapshot to the file `symbol_harvester_watch` uses (the newest 60 are kept).
- The whole run is limited to 120 seconds. At the limit the remaining items are skipped, the reason
  goes to stderr, and the result is WARN at best, printed even with `--quiet`.
- A typo in the subcommand name is an unknown argument of the server and exits with 2, as before.

## Security

- **Read-only.** No tool signs, builds or announces transactions. No argument accepts a private key,
  mnemonic or token. Nothing is stored between calls, except that `symbol_harvester_watch` keeps its
  per-node snapshot of unlocked harvester public keys, heights and times under `SYMBOL_STATE_DIR` when
  that variable is set (no secrets; delete the file to start over).
- **Fixed destinations.** The server contacts only `SYMBOL_NODE_URL` and, for
  `symbol_network_compare` and `symbol_version_drift`, the hosts listed in `SYMBOL_REFERENCE_NODES`. Tools never take a URL as
  an argument, so a model cannot redirect requests. There is no telemetry.
- **Untrusted chain data.** Transfer messages, node friendly names, host names and alias names are
  written by third parties. They are exposed under names that make this obvious (`messageText`),
  control and bidi characters are stripped, and length is capped. Treat them as data, not
  instructions.
- **Fail loudly.** A network mismatch (`SYMBOL_NETWORK` versus the node), an unreachable node or an
  unexpected response shape is an error with a recovery hint, never a silent fallback to another
  network. Stack traces and raw HTTP bodies are never returned to the model.
- **Request hygiene.** Per-request timeout, `User-Agent`, a 5 MB response cap, at most 4 concurrent
  requests, and schema validation of every response.

Vulnerability reports: see [`SECURITY.md`](SECURITY.md).

## Supported networks

| Network | Identifier | Detected by generation hash seed | Example node |
|---|---|---|---|
| Symbol mainnet | 104 | `57F7DA20…72B2D6` | `https://sym-main-01.opening-line.jp:3001` |
| Symbol testnet (sai) | 152 | `49D6E1CE…FC665A4` | `https://sym-test-01.opening-line.jp:3001` |

The network is detected from the node at start-up. Any other generation hash seed (private
networks, NEM NIS1) is rejected. Node availability changes over time; pick a current one from
https://nodewatch.symbol.tools/.

## Limitations

- **Node history.** Results come from the configured node. Nodes that prune transaction history
  return only what they still hold, so `symbol_transaction_search` may miss old transactions on
  such nodes.
- **Future dates are estimates.** Expiry dates for voting keys, namespaces and mosaics, and any
  future height or epoch, are projected from the measured average block time over the last 10,000
  blocks (about 30 s on mainnet) and are flagged as estimates.
- **Encrypted messages are not decrypted**; they are reported as encrypted.
- **Page size is 10 to 100**, because catapult-rest coerces smaller pages to 10.
- **Confirmed transactions only** in search. Unconfirmed and partial transactions are visible
  through `symbol_transaction_get` by hash.
- **Harvesting status covers the configured node** (`/node/unlockedaccount`), not the whole network.
- **No prices.** `symbol_holdings_value` multiplies a balance by a unit price the caller passes in; it
  does not fetch, check or remember prices, and the result is only as good as that input. Look the
  price up first (web search, a price MCP server, or the user) and pass it with `priceSource` and
  `priceAsOf`. The value is the plain product: no fees, spread or taxes, and no tax lot accounting.
- **Holder rank is a scan, not an index.** `symbol_account_rank` reads the holder list 100 accounts per
  request down to `maxRank` (at most 5,000, i.e. 50 requests); an account below that gets `rank: null`
  with `rankBeyond`. Equal balances are ordered by the node and may swap between calls.
- **Harvester history is local.** `symbol_harvester_watch` compares against snapshots it wrote itself
  under `SYMBOL_STATE_DIR`; another machine, a deleted file or a changed node key (a new node.key.pem
  after a migration) starts a new baseline. Repeated calls on the same day add repeated snapshots;
  only the newest 60 are kept.
- **Harvest income reads at most 20,000 statements per call** (200 pages of 100). A longer period
  comes back `truncated`; split it with `fromHeight`/`toHeight`. Rewards are summed from HarvestFee
  receipts, so a node that prunes receipts reports less than the chain holds.
- **Harvest income for a year is read in pieces.** catapult-rest answers a wide height range slowly,
  so the range is split into chunks of about 90 days that are read one after another; a chunk whose
  first page times out is halved (down to about 7 days) and retried. The totals are the same as from
  one query, the `fetch` field says how the range was read, and only a node that cannot answer about
  7 days within `SYMBOL_REQUEST_TIMEOUT_MS` makes the call fail.
- **Finality participation reads the proofs the node holds.** `unavailable` means the node has no
  proof for that epoch (not finalized yet, or outside the history it keeps), not that the account
  did not vote. The server does not know how many voters are registered, so `signatureCount` can
  only be compared with an external list such as nodewatch.
- **Version drift is sampled, not surveyed.** `symbol_version_drift` sees the peers the configured
  node currently knows plus the reference nodes, not the whole network; the full picture is on
  nodewatch. Clock skew in `symbol_node_health` is measured against the clock of the machine running
  this server, which may itself be off.
- **Mainnet and testnet only.** No transaction building, signing or announcing, by design.
- **The URL is used as given.** The server does not switch ports or schemes on its own; if a node
  only serves port 3000 over http, it cannot be used unless it is on localhost.

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test
npm run build
SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
npx @modelcontextprotocol/inspector node dist/index.js
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://sym-test-01.opening-line.jp:3001 npm test   # live-node tests
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<node-host>:3001 SYMBOL_INTEGRATION_ACCOUNT=<address> npm test   # account tools against a specific account
node scripts/capture-fixtures.mjs https://<node-host>:3001   # refresh test/fixtures/<network>/ from a node
```

Design notes: [`docs/DESIGN-BRIEF.md`](docs/DESIGN-BRIEF.md). Changes: [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
