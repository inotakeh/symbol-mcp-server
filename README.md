# symbol-mcp-server

> **Symbol only.** This server talks to [Symbol](https://docs.symbol.dev/) (catapult) nodes. It does not
> support NEM NIS1 (XEM), which is a separate chain with a different API.
> **Unofficial.** This is an independent project with no affiliation to the NEM or Symbol core teams.

[日本語版 README](README.ja.md)

Read-only [MCP](https://modelcontextprotocol.io/) server that turns the Symbol REST API into 13
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

- Node.js 20 or newer.
- A Symbol REST node reachable over `https://` (port 3001 on most public nodes). Public nodes are
  listed at https://nodewatch.symbol.tools/.

## Install

**From npm** (once published):

```sh
npx -y symbol-mcp-server --help
```

**From source** (the package is not on npm yet):

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
symbol-mcp-server 0.1.0: mainnet via <node-host>:3001, timezone Asia/Tokyo
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
claude mcp add symbol -e SYMBOL_NODE_URL=https://<node-host>:3001 -e SYMBOL_TIMEZONE=Asia/Tokyo -- npx -y symbol-mcp-server
# or, from a source checkout:
claude mcp add symbol -e SYMBOL_NODE_URL=https://<node-host>:3001 -- node /path/to/symbol-mcp-server/dist/index.js
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
| `SYMBOL_REFERENCE_NODES` | no | Comma-separated `https://` node URLs that `symbol_network_compare` checks against. No other host is ever contacted. |
| `SYMBOL_REQUEST_TIMEOUT_MS` | no | Per-request timeout, 100 to 600000. Default `10000`. |

## Tools

All 13 tools are read-only (`readOnlyHint: true`) and are listed in a fixed order. Arguments are
identifiers only, never URLs.

| Tool | Arguments | Answers |
|---|---|---|
| `symbol_network_info` | none | Network name/identifier and generation hash seed, current and finalized height, finalization epoch, block target time, voting set grouping, epoch adjustment, XYM mosaic id/alias/divisibility, current fee multipliers. |
| `symbol_node_status` | none | Friendly name, host, roles (Peer/API/Voting), decoded version, health of API node and database, heights, peer count, and a sync check (latest block older than 5 minutes means `synced: false`). |
| `symbol_account_get` | `account` (address or public key), `format` | Address in base32 and hex, public key, every mosaic balance with alias and decimals, importance, linked/VRF/node/voting keys, whether delegated harvesting is set up, multisig settings. |
| `symbol_voting_key_status` | `account` | Every voting key with status (expired/active/future), remaining epochs/blocks/days, estimated expiry date, recommended renewal window (7 to 3 days before), slot usage including expired keys, voter eligibility versus `minVoterBalance`, warnings. |
| `symbol_transaction_get` | `transactionHash` | Looks in confirmed, unconfirmed and partial groups and reports the status; type name, signer and recipient, mosaics with aliases, decoded plain message or "encrypted" marker, fee, height and time, inner transactions of aggregates. |
| `symbol_transaction_search` | `address`, `type`, `pageSize`, `pageNumber`, `order`, `format` | Confirmed transactions involving an account, newest first by default, optional type filter by name (`transfer`) or code (`16724`), 10 to 100 per page. |
| `symbol_mosaic_get` | `mosaic` (hex id or alias such as `symbol.xym`) | Supply, divisibility, flags (supply mutable, transferable, restrictable, revokable), owner, start height, duration and estimated expiry. |
| `symbol_namespace_get` | `namespace` (name or hex id) | Owner, root or sub, level names, alias target (address or mosaic), start and end height, estimated expiry date. |
| `symbol_fee_estimate` | `transactionSizeBytes` (optional) | Slow/average/median/fast fee tiers in XYM computed from the node's current multipliers. Nothing is signed or sent. |
| `symbol_address_parse` | `value` (address or public key) | Offline validation: checksum, network byte, base32/hex/dashed forms, and the addresses derived from a public key. |
| `symbol_time_convert` | one of `height`, `epoch`, `timestamp` | Height, finalization epoch, network timestamp and wall-clock time. Exact for the past, estimated (and flagged) for the future. |
| `symbol_harvesting_status` | `account` (optional) | Unlocked delegated harvesters on the node, harvesting limits and beneficiary percentage, and whether the given account's linked key is unlocked here. |
| `symbol_network_compare` | none | Height and finalization of the node versus `SYMBOL_REFERENCE_NODES`, blocks behind the best, `lagging` flags. Explains what to do when no reference nodes are configured. |

### Example questions

**"When does the voting key of NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY expire, and when should I renew it?"**
→ `symbol_voting_key_status { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY" }`
Returns each key's `startEpoch`/`endEpoch`, the expiry height `(endEpoch - 1) × votingSetGrouping`,
remaining epochs, blocks and days, an estimated expiry date based on the measured average block
time, the renewal window, free slots (expired keys still occupy slots) and whether the balance
meets `minVoterBalance`.

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

More cases, with the exact arguments expected for each, are in [`evals/cases.json`](evals/cases.json).

## Security

- **Read-only.** No tool signs, builds or announces transactions. No argument accepts a private key,
  mnemonic or token, and nothing is stored between calls.
- **Fixed destinations.** The server contacts only `SYMBOL_NODE_URL` and, for
  `symbol_network_compare`, the hosts listed in `SYMBOL_REFERENCE_NODES`. Tools never take a URL as
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
