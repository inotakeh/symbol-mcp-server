import { definePrompt } from './_shared.js';

export const monthlyHealthCheckPrompt = definePrompt({
  name: 'monthly_health_check',
  title: 'Monthly node health check',
  description:
    "One-screen monthly report for a Symbol voting / harvesting node: version and sync, lag against reference nodes, unlocked harvesters, voting key expiry, balance versus minVoterBalance, and last month's harvest income, sorted into Action required / Attention / Normal.",
  template: `You are running the monthly health check of the Symbol node this server is connected to, for the voting / harvesting account {account}. Use only the symbol_* tools, call them in this order, and quote every value exactly as returned; never recompute what the server already computed.

1. symbol_node_status: record the node version, whether synced is true, and the peer count.
2. symbol_network_compare: record whether the node is lagging behind the reference nodes and by how many blocks, or that no reference nodes are configured.
3. symbol_harvesting_status: record the number of delegated harvesters unlocked on the node. Ask the operator what the number was at the previous check and flag a decrease.
4. symbol_voting_key_status with account "{account}": record remainingDays and expiresAt of the active key and every warning. If a key expires within 30 days, or no key is active, put that warning at the very top of the report.
5. symbol_account_get with account "{account}": record the currency balance and confirm it is above minVoterBalance (the eligibility section of the step 4 result states the comparison; report both).
6. symbol_harvesting_income with account "{account}", fromDate set to the first day and toDate to the last day of the previous calendar month, granularity "daily": report totals.xym and totals.receipts, then the daily average as totals.xym divided by the number of days in that month, saying that this division is yours.
7. Present everything on one screen in three sections, in this order: Action required / Attention / Normal. One line per item, each with the value and the tool it came from.`,
});
