# Test fixtures

JSON bodies served by the fake `fetch` in `test/tools/harness.ts`. They are real REST response
shapes so the tool layer is exercised against payloads a node actually returns.

## Verbatim public data

Captured from a Symbol mainnet node and stored unchanged (`scripts/capture-fixtures.mjs` for the
transaction, namespace and unlocked-account files; the rest by hand):

`chain-info.json`, `network-properties.json`, `fees.json`, `node-health.json`,
`block-5753675.json`, `block-5763675.json`, `mosaic-xym.json`,
`namespace-symbol.json`, `namespace-symbol-xym.json`, `namespace-names.json`,
`transaction-transfer.json`, `transaction-aggregate.json`, `transaction-unconfirmed-404.json`.

The fake `fetch` answers a path that no route stubs the way catapult-rest answers a path it has no
route for: 404 `{"code":"ResourceNotFound","message":"<path> does not exist"}`, which the client
reports as an error. A test that expects "no such resource" stubs that exact path with
`resourceNotFound(id)` (404 `no resource exists with id '<id>'`, the shape of
`transaction-unconfirmed-404.json`).

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
| `finalization-proof-split-prevote.json` | Fully synthetic, built from `finalization-proof-epoch.json`; only its SHAPE follows a real mainnet proof (epoch 4027): three message groups, stage 1 once and stage 0 twice at the same height, the prevote signatures split 2 + 15, and the account's key in the group of 15 only. From the real proof: `finalizationEpoch` (4027), the prevote height (5796428) and the 2 / 15 split. Made up: `finalizationPoint` (22), the 21 / 13 hash counts and therefore the proof height (5796448), and which voters (#16, #17) form the small group. Signature entries are those of the epoch 4010 fixture, regrouped |
| `finalization-proof-epoch.json` | A real mainnet `GET /finalization/proof/epoch/4010` proof with every `parentPublicKey`, `signature`, entry of `hashes` and the top-level `hash` replaced. `version`, `finalizationEpoch` (4010), `finalizationPoint` (69), `height`, each group's `stage` and `height`, the signature count (17 per stage) and the hash count (21 in the prevote group) are verbatim |
| `namespace-alias-account.json` | Written by hand in the `GET /namespaces/{id}` response shape (copied from `namespace-symbol.json`): a root namespace `fixture-alias` whose address alias and owner are the synthetic main account, active, finite lifetime consistent with `chain-info.json` (start 5,000,000, end 6,500,000) |
| `transaction-status.json` | Written by hand in the `POST /transactionStatus` response shape. The confirmed row is the captured transfer (hash, height and deadline verbatim); the unconfirmed, partial and failed rows use synthetic hashes, height `0` and round deadlines near the fixture block time |
| `peers.json` | Written by hand in the `GET /node/peers` response shape (NodeInfoDTO[]): six mainnet peers with synthetic public keys and `.example` hosts, `roles` 3 / 1 / 7 / 5 / 1 / 3, and a version mix for `symbol_version_drift` (four at `16777993` = 1.0.3.9, one at `16777992` = 1.0.3.8, one at `16778240` = 1.0.4.0). Entry 02 keeps a control and a bidi character in `friendlyName` (as JSON escapes) so sanitisation stays exercised |
| `node-storage.json` | Written by hand in the `GET /node/storage` shape: `numBlocks` equals the `chain-info.json` height, the other counts are round synthetic values |
| `node-time.json` | Written by hand in the `GET /node/time` shape: `sendTimestamp` is the network time of `TEST_NOW` (harness.ts) minus 1 s, `receiveTimestamp` 5 ms earlier, so the clock skew is -1000 ms |
| `multisig-account.json`, `multisig-cosignatory.json` | Real mainnet `GET /account/{address}/multisig` responses: a 2-of-3 multisig account and its first cosignatory. `accountAddress`, `cosignatoryAddresses` and `multisigAddresses` replaced; `version`, `minApproval`, `minRemoval`, the key order and the list lengths (3 cosignatories / 1 multisig account, the cosignatory's `minApproval` and `minRemoval` 0) are verbatim. The multisig account is the synthetic main account, and the cosignatory file's account is its first cosignatory, as in the capture |
| `node-server.json` | Written by hand in the `GET /node/server` shape with synthetic `restVersion` / `sdkVersion` / `deployment` values |

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
| transaction status hashes (unconfirmed / partial / failed rows) | `H("fixture:status-hash-unconfirmed")`, `H("fixture:status-hash-partial")`, `H("fixture:status-hash-failed")` |
| finalization proof, root signer *NN* (numbered 01…17 by first appearance in the stage 1 group; the same real key gets the same number in both groups) | `root.parentPublicKey`: #01 is the main account's active voting key `H("fixture:voting-key-2")`, #02…#17 are `H("fixture:voter-NN")`; `bottom.parentPublicKey` `H("fixture:voter-NN-bottom")`; `root.signature` `H("fixture:proof-sig-root-NN:a") + …:b` (identical in both groups, as in the real proof); `bottom.signature` `H("fixture:proof-sig-<stage>-NN-bottom:a") + …:b` |
| split-prevote proof hashes | `H("fixture:proof-4027-hash-NN")` (NN 01…21) in the group of 15; the group of 2 lists the first 13 of them; the stage 1 hash and the top-level `hash` are the last one |
| finalization proof hashes | stage 0 `hashes[n]` (1-based) `H("fixture:proof-hash-NN")`; the stage 1 hash and the top-level `hash` are the last stage 0 hash, as in the real proof |
| block 5764879 | `signerPublicKey` = the linked key above, `beneficiaryAddress` = the main address; `meta.hash` `H("fixture:block-hash-5764879")`, `generationHash` `H("fixture:block-generation-hash")`, signature `H("fixture:block-sig:a") + H("fixture:block-sig:b")`, `proofGamma` `H("fixture:block-proof-gamma")`, `proofVerificationHash` first 16 bytes of `H("fixture:block-proof-verification-hash")`, `proofScalar` `H("fixture:block-proof-scalar")`, `previousBlockHash` / `transactionsHash` / `receiptsHash` / `stateHash` `H("fixture:block-<previous|transactions|receipts|state>-hash")`, `stateHashSubCacheMerkleRoots[i]` `H("fixture:block-subcache-root-i")` (1-based), document id first 12 bytes of `H("fixture:doc-id-block-5764879")` |
| multisig cosignatory *n* (1…3) | `H("fixture:cosignatory-n")` taken as a public key, then `publicKeyToAddress(…, 104)` in hex |
| node host / friendlyName | `mainnet-node.example` / `fixture-node` |
| peer *NN* (01…06) in `peers.json` | `publicKey` `H("fixture:peer-NN")`, host `peer-NN.example`, friendlyName `peer NN` |
| namespace `fixture-alias` | `level0` = `namespaceNameToHexId('fixture-alias')` from `src/domain/namespace.ts` (935F70F34BFD4E33); `ownerAddress` and `alias.address` = the main address in hex; document id first 12 bytes of `H("fixture:doc-id-namespace-alias")` |
| holder *NNN* (001…300) in the synthetic `GET /accounts` holder list (built in `test/tools/harness.ts` `syntheticHolders`, no JSON file) | `publicKey` `H("fixture:holder-NNN")`, address `publicKeyToAddress(…, 104)` in hex, document id first 12 bytes of `H("fixture:holder-doc-NNN")`; row 157 is the main account itself; balance of row *n* = the main account's XYM balance + (157 − *n*) × 1,000 XYM, so balances are strictly descending |

Numbers were changed to round synthetic values that keep the tests' arithmetic consistent with
`chain-info.json` (height 5,763,675, finalization epoch 4004) and the fixed test clock in
`harness.ts`.

`address-vectors.json` keeps three public key → address vectors from the `symbol/symbol`
repository as the correctness reference for `publicKeyToAddress`; the `fixture` entry there is the
synthetic account above and is only checked for consistency with the fixtures.
