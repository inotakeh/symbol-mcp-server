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
  'For when a voting key expires and when to renew it, call symbol_voting_key_status.',
  'Every amount, date and count in structuredContent is already computed by the server. Report those values as returned; never recompute, round or sum them yourself.',
].join(' ');
