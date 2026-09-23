/**
 * Server instructions, sent to the client in the initialize result (SDK v2 `ServerOptions`
 * option `instructions`). Hosts prepend this text to the model's context for every session, so it
 * stays under 150 words (test/unit/instructions.test.ts) and says only what tool descriptions
 * cannot: what the server refuses to do, how to name accounts, and which tool answers the
 * questions models most often route wrongly.
 */
export const SERVER_INSTRUCTIONS = [
  'symbol-mcp-server is read-only: no tool accepts a private key or mnemonic; nothing is signed or announced.',
  'Accounts: a 39-character base32 address, a 64-character hex public key, or a namespace name (alice) with an address alias.',
  'Harvest rewards are receipts: for harvesting income use symbol_harvesting_income, never symbol_transaction_search; for monthly totals or a spreadsheet, pass granularity "monthly" or output "csv".',
  'To value holdings, pass a unit price obtained elsewhere (web search, another MCP, the user) to symbol_holdings_value; never multiply balance by price yourself.',
  'Route by question: rank or rich list, symbol_account_rank; voting key expiry, symbol_voting_key_status; finalization votes signed, symbol_finality_participation; delegated harvesting not working, symbol_delegation_diagnose; delegators gained or lost, symbol_harvester_watch; node services healthy, symbol_node_health; node in sync, symbol_node_status; version behind the network, symbol_version_drift; blocks behind other nodes, symbol_network_compare; transaction went through or failed, symbol_transaction_status.',
  'Every amount, date and count is server-computed; report values as returned, never recompute, round or sum them.',
].join(' ');
