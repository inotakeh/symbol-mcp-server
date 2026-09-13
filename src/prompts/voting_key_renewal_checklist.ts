import { definePrompt } from './_shared.js';

export const votingKeyRenewalChecklistPrompt = definePrompt({
  name: 'voting_key_renewal_checklist',
  title: 'Voting key renewal checklist',
  description:
    "Step-by-step renewal of a Symbol voting key: check the current key and free slots, confirm the node is synced and not lagging, verify the operator's VotingKeyLink transaction by hash, and confirm the new key is registered. The server never signs or announces; the operator runs the link commands.",
  template: `You are helping the operator of a Symbol voting node renew the voting key of account {account}. Work through the steps in order using only the symbol_* tools of this server. Quote epochs, heights, dates and counts exactly as the tools return them; never recompute them.

1. Call symbol_voting_key_status with account "{account}". Record for the active key: endEpoch, expiresAt (the estimated expiry date and time) and recommendedRenewalWindow; record slotsFree and expiredKeysOccupyingSlots from constraints. If slotsFree is 0, an expired key has to be unlinked before a new key can be registered: say so explicitly.
2. Call symbol_node_status and check that synced is true. If the node is not synced, stop here and tell the operator to wait: do not start the renewal on a node that is behind.
3. Call symbol_network_compare and report how many blocks the node trails the reference nodes and whether it is flagged lagging, or that no reference nodes are configured.
4. Generating the new key and announcing the VotingKeyLink transaction (and the unlink of an expired key) are done by the operator outside this server, which never signs or announces anything. Ask the operator to run those steps and to paste the transaction hash or hashes. For every hash you receive, call symbol_transaction_status and expect group "confirmed". If the group is "failed", report code and codeMeaning; if it is "unconfirmed" or "partial", ask the operator to wait and check again.
5. After confirmation, call symbol_voting_key_status once more. Confirm that the new key is listed with status "active" or "future", and that the expired key was unlinked so its slot is free again.
6. Finish with exactly four lines: Current key / New key / Expiry / Open items.`,
});
