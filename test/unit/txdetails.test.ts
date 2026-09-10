import { describe, expect, it } from 'vitest';
import { extractTransactionDetails, TransactionDetailsSchema } from '../../src/domain/txdetails.js';
import { fixture } from '../tools/harness.js';

const HEX_ADDRESS = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';
const BASE32 = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const ALIAS_ADDRESS = `69EEAFF441BA994BE7${'0'.repeat(30)}`;
const KEY = 'AB7F7D44A60051C5657932A8FBB4C2D81D0764236E84A0F3398AEDEBB6BC2BC2';

/** Every result must validate against the published schema. */
function details(tx: Record<string, unknown> & { type: number }) {
  const d = extractTransactionDetails(tx);
  expect(TransactionDetailsSchema.safeParse(d).success, JSON.stringify(d)).toBe(true);
  return d;
}

describe('extractTransactionDetails', () => {
  it('returns kind none for transfers and aggregates', () => {
    expect(details({ type: 0x4154, recipientAddress: HEX_ADDRESS })).toEqual({ kind: 'none' });
    expect(details({ type: 0x4141 })).toEqual({ kind: 'none' });
    expect(details({ type: 0x4241 })).toEqual({ kind: 'none' });
  });

  it('decodes the VotingKeyLink row of the captured search page', () => {
    const page = fixture<{
      data: Array<{ transaction: Record<string, unknown> & { type: number } }>;
    }>('mainnet/transactions-search.json');
    const row = page.data[1]?.transaction;
    expect(row?.type).toBe(0x4143);
    const d = details(row as Record<string, unknown> & { type: number });
    expect(d).toMatchObject({
      kind: 'votingKeyLink',
      linkAction: 'link',
      startEpoch: expect.any(Number),
      endEpoch: expect.any(Number),
    });
    expect(d.kind === 'votingKeyLink' && d.endEpoch > d.startEpoch).toBe(true);
    expect(d.kind === 'votingKeyLink' && d.linkedPublicKey).toMatch(/^[0-9A-F]{64}$/);
  });

  it('decodes account, vrf and node key links', () => {
    for (const type of [0x414c, 0x4243, 0x424c]) {
      expect(details({ type, linkedPublicKey: KEY.toLowerCase(), linkAction: 0 })).toEqual({
        kind: 'keyLink',
        linkedPublicKey: KEY,
        linkAction: 'unlink',
      });
    }
  });

  it('decodes namespace registrations and aliases', () => {
    expect(
      details({
        type: 0x414e,
        id: 'a95f1f8a96159516',
        name: 'symbol',
        registrationType: 0,
        duration: '2102400',
      }),
    ).toEqual({
      kind: 'namespaceRegistration',
      id: 'A95F1F8A96159516',
      name: 'symbol',
      registrationType: 'root',
      duration: '2102400',
      parentId: null,
    });
    expect(
      details({
        type: 0x414e,
        id: 'E74B99BA41F4AFEE',
        name: 'xym',
        registrationType: 1,
        parentId: 'A95F1F8A96159516',
      }),
    ).toMatchObject({ registrationType: 'child', parentId: 'A95F1F8A96159516', duration: null });
    expect(
      details({
        type: 0x424e,
        namespaceId: 'E74B99BA41F4AFEE',
        address: HEX_ADDRESS,
        aliasAction: 1,
      }),
    ).toEqual({
      kind: 'addressAlias',
      namespaceId: 'E74B99BA41F4AFEE',
      address: BASE32,
      aliasAction: 'link',
    });
    expect(
      details({
        type: 0x434e,
        namespaceId: 'E74B99BA41F4AFEE',
        mosaicId: '6BED913FA20223F8',
        aliasAction: 1,
      }),
    ).toMatchObject({
      kind: 'mosaicAlias',
      mosaicId: '6BED913FA20223F8',
    });
  });

  it('decodes mosaic definition flags and supply changes', () => {
    expect(
      details({
        type: 0x414d,
        id: '66BAE04E8758599E',
        nonce: 12,
        flags: 7,
        divisibility: 3,
        duration: '0',
      }),
    ).toEqual({
      kind: 'mosaicDefinition',
      id: '66BAE04E8758599E',
      nonce: 12,
      flags: {
        supplyMutable: true,
        transferable: true,
        restrictable: true,
        revokable: false,
        raw: 7,
      },
      divisibility: 3,
      duration: '0',
    });
    expect(
      details({ type: 0x424d, mosaicId: '66BAE04E8758599E', delta: '1000', action: 1 }),
    ).toEqual({
      kind: 'mosaicSupplyChange',
      mosaicId: '66BAE04E8758599E',
      delta: '1000',
      action: 'increase',
    });
    expect(
      details({
        type: 0x434d,
        sourceAddress: ALIAS_ADDRESS,
        mosaicId: '66BAE04E8758599E',
        amount: '5',
      }),
    ).toEqual({
      kind: 'mosaicSupplyRevocation',
      sourceAddress: 'alias:E74B99BA41F4AFEE',
      mosaicId: '66BAE04E8758599E',
      amount: '5',
    });
  });

  it('decodes locks, proofs and multisig modifications', () => {
    expect(
      details({
        type: 0x4148,
        mosaicId: '6BED913FA20223F8',
        amount: '10000000',
        duration: '480',
        hash: KEY,
      }),
    ).toMatchObject({
      kind: 'hashLock',
      amount: '10000000',
      hash: KEY,
    });
    expect(
      details({
        type: 0x4152,
        recipientAddress: HEX_ADDRESS,
        secret: KEY,
        mosaicId: '6BED913FA20223F8',
        amount: '1',
        duration: '10',
        hashAlgorithm: 1,
      }),
    ).toMatchObject({
      kind: 'secretLock',
      recipientAddress: BASE32,
      hashAlgorithm: { code: 1, name: 'HASH_160' },
    });
    expect(
      details({
        type: 0x4252,
        recipientAddress: HEX_ADDRESS,
        secret: KEY,
        hashAlgorithm: 0,
        proof: 'abcd',
      }),
    ).toMatchObject({
      kind: 'secretProof',
      proof: 'ABCD',
      hashAlgorithm: { code: 0, name: 'SHA3_256' },
    });
    expect(
      details({
        type: 0x4155,
        minRemovalDelta: 1,
        minApprovalDelta: 2,
        addressAdditions: [HEX_ADDRESS, ALIAS_ADDRESS],
        addressDeletions: [],
      }),
    ).toEqual({
      kind: 'multisigAccountModification',
      minRemovalDelta: 1,
      minApprovalDelta: 2,
      addressAdditions: [BASE32, 'alias:E74B99BA41F4AFEE'],
      addressDeletions: [],
    });
  });

  it('decodes metadata and restrictions', () => {
    expect(
      details({
        type: 0x4244,
        targetAddress: HEX_ADDRESS,
        scopedMetadataKey: 'a1b2',
        targetMosaicId: '6BED913FA20223F8',
        valueSizeDelta: 4,
        valueSize: 4,
        value: '74657374',
      }),
    ).toEqual({
      kind: 'metadata',
      metadataType: 'mosaic',
      targetAddress: BASE32,
      scopedMetadataKey: 'A1B2',
      targetMosaicId: '6BED913FA20223F8',
      targetNamespaceId: null,
      valueSizeDelta: 4,
      valueSize: 4,
      value: '74657374',
    });
    expect(
      details({
        type: 0x4150,
        restrictionFlags: 0xc001,
        restrictionAdditions: [HEX_ADDRESS],
        restrictionDeletions: [],
      }),
    ).toEqual({
      kind: 'accountRestriction',
      restrictionType: 'address',
      direction: 'outgoing',
      mode: 'block',
      restrictionFlags: 0xc001,
      restrictionAdditions: [BASE32],
      restrictionDeletions: [],
    });
    expect(
      details({
        type: 0x4350,
        restrictionFlags: 0x4004,
        restrictionAdditions: [16724],
        restrictionDeletions: [],
      }),
    ).toMatchObject({
      restrictionType: 'transactionType',
      direction: 'outgoing',
      mode: 'allow',
      restrictionAdditions: ['16724'],
    });
    expect(
      details({
        type: 0x4151,
        mosaicId: '66BAE04E8758599E',
        referenceMosaicId: '0000000000000000',
        restrictionKey: 'ff',
        previousRestrictionValue: '0',
        newRestrictionValue: '1',
        previousRestrictionType: 0,
        newRestrictionType: 1,
      }),
    ).toMatchObject({
      kind: 'mosaicGlobalRestriction',
      previousRestrictionType: { code: 0, name: 'NONE' },
      newRestrictionType: { code: 1, name: 'EQ' },
    });
  });

  it('falls back to scalar fields for unknown types or malformed known types', () => {
    expect(
      details({ type: 0x9999, signature: 'x', foo: 'bar', n: 1, flag: true, obj: { a: 1 } }),
    ).toEqual({
      kind: 'other',
      fields: { foo: 'bar', n: 1, flag: true },
    });
    expect(details({ type: 0x414c, linkedPublicKey: 'not-a-key', linkAction: 1 })).toEqual({
      kind: 'other',
      fields: { linkedPublicKey: 'not-a-key', linkAction: 1 },
    });
  });
});
