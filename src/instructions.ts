/**
 * Server instructions, sent to the client in the initialize result (SDK v2 `ServerOptions`
 * option `instructions`). Hosts prepend this text to the model's context for every session, so it
 * stays under 150 words (test/unit/instructions.test.ts) and says only what tool descriptions
 * cannot: what the server refuses to do, how to name accounts, and which tool answers the
 * questions models most often route wrongly.
 */
export const SERVER_INSTRUCTIONS = [
  'symbol-mcp-server is a read-only view of one Symbol blockchain node: no tool accepts a private key or mnemonic, and nothing is ever signed or announced.',
  'Identify an account by its 39-character base32 address or its 64-character hex public key.',
  'Harvest rewards are receipts, not transactions. For any question about harvesting income, rewards or earnings call symbol_harvesting_income; do not use symbol_transaction_search or a web browser for that.',
  'For monthly or yearly totals or a spreadsheet, pass granularity "monthly" or output "csv".',
  'For when a voting key expires and when to renew it, call symbol_voting_key_status; for whether that key actually signed finalization votes, call symbol_finality_participation.',
  'If delegated harvesting is not working or you need to know whether it is active, call symbol_delegation_diagnose.',
  'Every amount, date and count is computed by the server; report values as returned and never recompute, round or sum them.',
].join(' ');
