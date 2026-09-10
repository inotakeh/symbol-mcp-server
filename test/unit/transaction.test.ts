import { describe, expect, it } from 'vitest';
import { TransactionInfoSchema } from '../../src/client/schemas.js';
import {
  collectMosaicIds,
  collectRecipientNamespaceIds,
  parseUnresolvedAddress,
  type SummarizeOptions,
  summarizeTransaction,
} from '../../src/domain/transaction.js';
import { fixture } from '../tools/harness.js';

const OPTS: SummarizeOptions = {
  networkIdentifier: 104,
  epochAdjustmentSeconds: 1_615_853_185,
  currencyDivisibility: 6,
  timeZone: 'Asia/Tokyo',
  mosaicMeta: new Map([['6BED913FA20223F8', { alias: 'symbol.xym', divisibility: 6 }]]),
  namespaceNames: new Map([['E74B99BA41F4AFEE', 'symbol.xym']]),
};

describe('parseUnresolvedAddress', () => {
  it('decodes a plain address', () => {
    expect(parseUnresolvedAddress('68026181AB5533B1EA507508A79B08F381429C83B6B7B2AB')).toEqual({
      kind: 'address',
      base32: 'NABGDANLKUZ3D2SQOUEKPGYI6OAUFHEDW233FKY',
    });
  });
  it('decodes a namespace alias (network byte with bit 0 set, little-endian id)', () => {
    // 0x69 = mainnet 0x68 | alias flag; then E74B99BA41F4AFEE little-endian; then zero padding.
    expect(parseUnresolvedAddress(`69EEAFF441BA994BE7${'0'.repeat(30)}`)).toEqual({
      kind: 'namespace',
      namespaceId: 'E74B99BA41F4AFEE',
    });
  });
});

describe('summarizeTransaction', () => {
  const transfer = TransactionInfoSchema.parse(fixture('mainnet/transaction-transfer.json'));
  const aggregate = TransactionInfoSchema.parse(fixture('mainnet/transaction-aggregate.json'));

  it('summarises the captured transfer', () => {
    const s = summarizeTransaction(transfer, OPTS);
    expect(s.hash).toBe('FAEEB0420BF639D4ACB6C2934BF22C3F5AB71DED20D4EAB986CF2C18B914C12F');
    expect(s.type).toEqual({ code: 16724, name: 'Transfer' });
    expect(s.height).toBe(5_763_959);
    expect(s.timestamp).toEqual({
      utc: '2026-09-10T05:22:47.867Z',
      local: '2026-09-10T14:22:47+09:00',
    });
    expect(s.signer.publicKey).toBe(
      'AB7F7D44A60051C5657932A8FBB4C2D81D0764236E84A0F3398AEDEBB6BC2BC2',
    );
    expect(s.signer.address).toMatch(/^N[A-Z2-7]{38}$/);
    expect(s.recipient).toEqual({
      address: 'NABGDANLKUZ3D2SQOUEKPGYI6OAUFHEDW233FKY',
      namespaceId: null,
      namespaceName: null,
    });
    expect(s.mosaics).toEqual([
      {
        id: '6BED913FA20223F8',
        alias: 'symbol.xym',
        amount: '24999.800064',
        rawAmount: '24999800064',
        divisibility: 6,
      },
    ]);
    expect(s.message).toEqual({ kind: 'empty', sizeBytes: 0 });
    expect(s.fee).toEqual({
      maxFee: '0.200000',
      rawMaxFee: '200000',
      paidFee: '0.199936',
      rawPaidFee: '199936',
      feeMultiplier: 1136,
      sizeBytes: 176,
    });
    expect(s.details).toEqual({ kind: 'none' });
    expect(s.innerTransactions).toEqual([]);
    expect(s.cosignatureCount).toBe(0);
  });

  it('summarises the captured aggregate with decoded inner transfers', () => {
    const s = summarizeTransaction(aggregate, OPTS);
    expect(s.type.name).toBe('AggregateComplete');
    expect(s.recipient).toBeNull();
    expect(s.message).toBeNull();
    expect(s.innerTransactions).toHaveLength(2);
    expect(s.innerTransactions[0]).toMatchObject({
      index: 0,
      type: { name: 'Transfer' },
      recipient: { address: expect.stringMatching(/^N[A-Z2-7]{38}$/) },
      message: { kind: 'plain', messageText: 'Supplement to the withdrawal hot wallet' },
      mosaics: [{ alias: 'symbol.xym', amount: '106271.711424' }],
    });
    expect(s.innerTransactions[1]?.message).toMatchObject({
      kind: 'plain',
      messageText: 'Transfer to a cold wallet',
    });
    expect(s.fee.paidFee).toBe('1.081296'); // 432 bytes x 2503
  });

  it('exposes type-specific fields in details and treats unknown mosaics gracefully', () => {
    const page = fixture<{ data: unknown[] }>('mainnet/transactions-search.json');
    const votingLink = TransactionInfoSchema.parse(page.data[1]);
    const s = summarizeTransaction(votingLink, OPTS);
    expect(s.type.name).toBe('VotingKeyLink');
    expect(s.details).toMatchObject({
      kind: 'votingKeyLink',
      linkAction: 'link',
      startEpoch: expect.any(Number),
      endEpoch: expect.any(Number),
    });
    expect(s.details.kind === 'votingKeyLink' && s.details.linkedPublicKey).toMatch(
      /^[0-9A-F]{64}$/,
    );
    expect(s.recipient).toBeNull();

    const unknownMosaic = TransactionInfoSchema.parse({
      ...transfer,
      transaction: { ...transfer.transaction, mosaics: [{ id: '1234567890ABCDEF', amount: '5' }] },
    });
    expect(summarizeTransaction(unknownMosaic, OPTS).mosaics[0]).toEqual({
      id: '1234567890ABCDEF',
      alias: null,
      amount: '5',
      rawAmount: '5',
      divisibility: null,
    });
  });

  it('handles unconfirmed meta without height or timestamp', () => {
    const unconfirmed = TransactionInfoSchema.parse({
      ...transfer,
      meta: { hash: transfer.meta.hash, merkleComponentHash: transfer.meta.hash, index: 0 },
    });
    const s = summarizeTransaction(unconfirmed, OPTS);
    expect(s.height).toBeNull();
    expect(s.timestamp).toBeNull();
    expect(s.fee.paidFee).toBeNull();
    expect(s.fee.maxFee).toBe('0.200000');
  });

  it('collects mosaic and alias-recipient ids across inner transactions', () => {
    expect(collectMosaicIds(aggregate)).toEqual(['6BED913FA20223F8']);
    expect(collectRecipientNamespaceIds(aggregate)).toEqual([]);
    const aliased = TransactionInfoSchema.parse({
      ...transfer,
      transaction: {
        ...transfer.transaction,
        recipientAddress: `69EEAFF441BA994BE7${'0'.repeat(30)}`,
      },
    });
    expect(collectRecipientNamespaceIds(aliased)).toEqual(['E74B99BA41F4AFEE']);
    expect(summarizeTransaction(aliased, OPTS).recipient).toEqual({
      address: null,
      namespaceId: 'E74B99BA41F4AFEE',
      namespaceName: 'symbol.xym',
    });
  });
});
