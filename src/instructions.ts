/**
 * Server instructions, sent to the client in the initialize result (SDK v2 `ServerOptions`
 * option `instructions`). Hosts prepend this text to the model's context for every session, so it
 * stays under 150 words (test/unit/instructions.test.ts) and says only what tool descriptions
 * cannot: what the server refuses to do, how to name accounts, and which tool answers the
 * questions models most often route wrongly.
 */
export const SERVER_INSTRUCTIONS = [
  'symbol-mcp-server is a read-only view of one Symbol node: no tool accepts a private key or mnemonic; nothing is signed or announced.',
  'Identify an account by its 39-character base32 address, its 64-character hex public key, or a namespace name (alice) with an address alias.',
  'Harvest rewards are receipts, not transactions: for harvesting income or earnings call symbol_harvesting_income, never symbol_transaction_search.',
  'For monthly totals or a spreadsheet, pass granularity "monthly" or output "csv".',
  'For when a voting key expires, call symbol_voting_key_status; for whether it signed finalization votes, symbol_finality_participation.',
  'If delegated harvesting is not working, call symbol_delegation_diagnose; for whether delegators increased or decreased since the last check, symbol_harvester_watch.',
  'For node health (database, clock, storage, finalization lag) call symbol_node_health; for whether its version is behind the network, symbol_version_drift.',
  'Every amount, date and count is computed by the server; report values as returned and never recompute, round or sum them.',
].join(' ');
