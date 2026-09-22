/**
 * Server instructions, sent to the client in the initialize result (SDK v2 `ServerOptions`
 * option `instructions`). Hosts prepend this text to the model's context for every session, so it
 * stays under 150 words (test/unit/instructions.test.ts) and says only what tool descriptions
 * cannot: what the server refuses to do, how to name accounts, and which tool answers the
 * questions models most often route wrongly.
 */
export const SERVER_INSTRUCTIONS = [
  'symbol-mcp-server is read-only: no tool accepts a private key or mnemonic; nothing is signed or announced.',
  'An account is a 39-character base32 address, a 64-character hex public key, or a namespace name (alice) with an address alias.',
  'Harvest rewards are receipts: for harvesting income use symbol_harvesting_income, never symbol_transaction_search.',
  'For monthly totals or a spreadsheet, pass granularity "monthly" or output "csv".',
  'For rank by holdings or a rich list, symbol_account_rank.',
  'To value holdings in a currency, pass a unit price obtained elsewhere (web search, another MCP, the user) to symbol_holdings_value; never multiply balance by price yourself.',
  'For voting key expiry, symbol_voting_key_status; for whether it signed finalization votes, symbol_finality_participation.',
  'If delegated harvesting is not working, symbol_delegation_diagnose; for delegator increase or decrease, symbol_harvester_watch.',
  'For node health, symbol_node_health; for a version behind the network, symbol_version_drift.',
  'Every amount, date and count is server-computed; report values as returned, never recompute, round or sum them.',
].join(' ');
