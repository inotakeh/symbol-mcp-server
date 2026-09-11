# Test fixtures

JSON bodies served by the fake `fetch` in `test/tools/harness.ts`. They are real REST response
shapes so the tool layer is exercised against payloads a node actually returns.

## Verbatim public data

Captured from a Symbol mainnet node and stored unchanged (`scripts/capture-fixtures.mjs` for the
transaction, namespace and unlocked-account files; the rest by hand):

`chain-info.json`, `network-properties.json`, `fees.json`, `node-health.json`, `peers.json`
(hosts partly replaced with `.example` names), `block-5753675.json`, `block-5763675.json`, `mosaic-xym.json`,
`namespace-symbol.json`, `namespace-symbol-xym.json`, `namespace-names.json`,
`transaction-transfer.json`, `transaction-aggregate.json`, `transaction-unconfirmed-404.json`,
`not-found.json`.

## Account-specific fixtures (identifiers replaced)

These were captured for a voting account on mainnet and for the mainnet node it harvests on, then
post-processed so that no on-chain identifier of that account, its counterparties or its node
remains. The response **shape** is untouched; only values were replaced:

| File | What was replaced |
|---|---|
| `account-voting.json` | address, public key, linked / vrf / node / voting keys, balances, importance, heights, document id |
| `node-info.json` | host, friendlyName, public keys |
| `unlockedaccount.json` | all 15 delegated harvester public keys |
| `mosaic-other.json`, `mosaic-names.json` | mosaic id, owner address, document id |
| `transactions-search.json` | hashes, signatures, signer / cosigner / linked public keys, heights, timestamps, epochs, document ids |
| `statements-harvest-page1.json`, `statement-harvest-one-block.json` | every receipt `targetAddress` (the account, the other delegated harvesters, the network sink), document ids. Heights, timestamps and amounts are verbatim |
| `block-5764879.json` | signer public key, beneficiary address, block and generation hash, signature, VRF proof, previous / transactions / receipts / state hashes, sub-cache merkle roots, document id. Height, timestamp, difficulty and size are verbatim |

Every synthetic value is derived deterministically, so the fixtures can be regenerated without
the original data. `H(label)` is SHA3-256 of the UTF-8 label, upper-case hex:

| Value | Derivation |
|---|---|
| main account public key | `H("fixture:main-account")` |
| main address | `publicKeyToAddress(publicKey, 104)` from `src/domain/address.ts`; hex form via `base32AddressToHex` |
| linked / vrf / node keys | `H("fixture:linked-key")`, `H("fixture:vrf-key")`, `H("fixture:node-key")` |
| voting keys (expired, active) | `H("fixture:voting-key-1")`, `H("fixture:voting-key-2")` |
| earlier voting keys in the search page | `H("fixture:voting-key-old-1")` … `-4`, in order of first appearance |
| counterparty signer / cosigner | `H("fixture:counterparty-1")`, `H("fixture:counterparty-2")` |
| unlocked harvesters 2–15 | `H("fixture:harvester-02")` … `H("fixture:harvester-15")`; entry 1 is the linked key |
| transaction hash, row *n* | `H("fixture:tx-hash-n")`; AggregateBonded rows use `H("fixture:tx-merkle-n")` for `merkleComponentHash` |
| `transactionsHash`, row *n* | `H("fixture:tx-inner-n")` |
| signature, row *n* | `H("fixture:tx-sig-n:a") + H("fixture:tx-sig-n:b")`; cosignatures use `fixture:cosig-n` |
| document `id` | first 12 bytes of `H("fixture:doc-id-n")`, `H("fixture:doc-id-account")`, `H("fixture:doc-id-mosaic")` |
| other mosaic id | first 8 bytes of `H("fixture:mosaic-other")` with the top bit cleared |
| harvest receipt targets other than the main account | `H("fixture:harvest-peer-n")` (n = 1…3, in order of receipt frequency) taken as a public key, then `publicKeyToAddress(…, 104)` in hex |
| statement document `id`, row *n* | first 12 bytes of `H("fixture:doc-id-statement-n")` |
| block 5764879 | `signerPublicKey` = the linked key above, `beneficiaryAddress` = the main address; `meta.hash` `H("fixture:block-hash-5764879")`, `generationHash` `H("fixture:block-generation-hash")`, signature `H("fixture:block-sig:a") + H("fixture:block-sig:b")`, `proofGamma` `H("fixture:block-proof-gamma")`, `proofVerificationHash` first 16 bytes of `H("fixture:block-proof-verification-hash")`, `proofScalar` `H("fixture:block-proof-scalar")`, `previousBlockHash` / `transactionsHash` / `receiptsHash` / `stateHash` `H("fixture:block-<previous|transactions|receipts|state>-hash")`, `stateHashSubCacheMerkleRoots[i]` `H("fixture:block-subcache-root-i")` (1-based), document id first 12 bytes of `H("fixture:doc-id-block-5764879")` |
| node host / friendlyName | `mainnet-node.example` / `fixture-node` |

Numbers were changed to round synthetic values that keep the tests' arithmetic consistent with
`chain-info.json` (height 5,763,675, finalization epoch 4004) and the fixed test clock in
`harness.ts`.

`address-vectors.json` keeps three public key → address vectors from the `symbol/symbol`
repository as the correctness reference for `publicKeyToAddress`; the `fixture` entry there is the
synthetic account above and is only checked for consistency with the fixtures.
