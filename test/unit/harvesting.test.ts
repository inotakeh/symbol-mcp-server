import { describe, expect, it } from 'vitest';
import type { Receipt, TransactionStatementInfo } from '../../src/client/schemas.js';
import {
  aggregateHarvestIncome,
  classifyHarvestReceipts,
  firstHeightAtOrAfter,
  lastHeightAtOrBefore,
} from '../../src/domain/harvesting.js';

const XYM = '6BED913FA20223F8';
const OTHER_MOSAIC = '66BAE04E8758599E';
const HARVEST_FEE = 8515;
const INFLATION = 20803;
const EPOCH_ADJUSTMENT = 1_615_853_185;
/** Synthetic fixture account (test/fixtures/address-vectors.json "fixture"). */
const ME = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';
const PEER = `68${'A'.repeat(46)}`;
const SINK = `68${'B'.repeat(46)}`;
const SHARES = { beneficiaryPercentage: 25, networkPercentage: 5 };

function receipt(
  amount: string,
  targetAddress: string,
  mosaicId = XYM,
  type = HARVEST_FEE,
): Receipt {
  return { version: 1, type, mosaicId, amount, targetAddress };
}

function statement(
  height: number,
  timestamp: string,
  receipts: Receipt[],
): TransactionStatementInfo {
  return {
    id: 'x',
    meta: { timestamp },
    statement: { height: String(height), source: { primaryId: 0, secondaryId: 0 }, receipts },
  };
}

describe('classifyHarvestReceipts', () => {
  it('identifies the three shares regardless of receipt order', () => {
    const out = classifyHarvestReceipts(
      [receipt('51247120', ME), receipt('3660508', SINK), receipt('18302542', ME)],
      SHARES,
    );
    expect(out.map((c) => [c.kind, c.amount.toString()])).toEqual([
      ['harvester', '51247120'],
      ['beneficiary', '18302542'],
      ['unknown', '3660508'],
    ]);
  });
  it('treats a two-receipt (100-N):N statement as harvester plus network', () => {
    const out = classifyHarvestReceipts(
      [receipt('3995831', SINK), receipt('75920799', PEER)],
      SHARES,
    );
    expect(out.map((c) => c.kind)).toEqual(['harvester', 'unknown']);
  });
  it('marks a statement unknown when the split is off by more than one point', () => {
    // 60/35/5 instead of 70/25/5
    const out = classifyHarvestReceipts(
      [receipt('60000000', ME), receipt('35000000', PEER), receipt('5000000', SINK)],
      SHARES,
    );
    expect(out.every((c) => c.kind === 'unknown')).toBe(true);
  });
  it('accepts a split within one percentage point (rounding of odd totals)', () => {
    const out = classifyHarvestReceipts(
      [receipt('70', ME), receipt('25', PEER), receipt('6', SINK)],
      SHARES,
    );
    expect(out.map((c) => c.kind)).toEqual(['harvester', 'beneficiary', 'unknown']);
  });
  it('marks one, four or zero-amount receipt sets unknown', () => {
    expect(classifyHarvestReceipts([receipt('1', ME)], SHARES)[0]?.kind).toBe('unknown');
    expect(
      classifyHarvestReceipts(
        [receipt('70', ME), receipt('25', PEER), receipt('5', SINK), receipt('1', PEER)],
        SHARES,
      ).every((c) => c.kind === 'unknown'),
    ).toBe(true);
    expect(
      classifyHarvestReceipts([receipt('0', ME), receipt('0', PEER)], SHARES).every(
        (c) => c.kind === 'unknown',
      ),
    ).toBe(true);
  });
  it('follows the network percentages instead of a fixed 70/25/5', () => {
    const out = classifyHarvestReceipts(
      [receipt('80', ME), receipt('10', PEER), receipt('10', SINK)],
      { beneficiaryPercentage: 10, networkPercentage: 10 },
    );
    expect(out.map((c) => c.kind)).toEqual(['harvester', 'beneficiary', 'unknown']);
  });
});

describe('aggregateHarvestIncome', () => {
  const opts = {
    targetAddressHex: ME,
    currencyMosaicId: XYM,
    harvestFeeType: HARVEST_FEE,
    shares: SHARES,
    epochAdjustmentSeconds: EPOCH_ADJUSTMENT,
  };
  // Network timestamps from the captured statements (epochAdjustment 1615853185 s).
  const T1 = '173192454149'; // 2026-09-10T13:07:19.149Z = 2026-09-10 22:07 Asia/Tokyo
  const T2 = '173213711715'; // 2026-09-10T19:01:36.715Z = 2026-09-11 04:01 Asia/Tokyo

  it('counts harvester and beneficiary receipts of the same block separately and sums with BigInt', () => {
    const out = aggregateHarvestIncome(
      [
        statement(5764879, T1, [
          receipt('51247120', ME),
          receipt('3660508', SINK),
          receipt('18302542', ME),
          { version: 1, type: INFLATION, mosaicId: XYM, amount: '73210170' },
        ]),
        statement(5766293, T2, [
          receipt('51247120', PEER),
          receipt('18302542', ME),
          receipt('3660508', SINK),
        ]),
      ],
      opts,
    );
    expect(out.rows.map((r) => [r.height, r.kind, r.raw.toString()])).toEqual([
      [5764879, 'harvester', '51247120'],
      [5764879, 'beneficiary', '18302542'],
      [5766293, 'beneficiary', '18302542'],
    ]);
    expect(out.rows[0]?.time.toISOString()).toBe('2026-09-10T13:07:19.149Z');
    expect(out.totals).toEqual({
      receipts: 3,
      raw: 87852204n,
      harvester: { receipts: 1, raw: 51247120n },
      beneficiary: { receipts: 2, raw: 36605084n },
      unknown: { receipts: 0, raw: 0n },
    });
    expect(out.unknownStatements).toBe(0);
    // Both blocks fall on 2026-09-10 in UTC.
    expect(out.daily.map((d) => [d.date, d.receipts, d.raw.toString()])).toEqual([
      ['2026-09-10', 3, '87852204'],
    ]);
  });

  it('buckets by the configured zone, so the same blocks split across two Tokyo days', () => {
    const out = aggregateHarvestIncome(
      [
        statement(1, T1, [receipt('70', ME), receipt('25', PEER), receipt('5', SINK)]),
        statement(2, T2, [receipt('70', ME), receipt('25', PEER), receipt('5', SINK)]),
      ],
      { ...opts, timeZone: 'Asia/Tokyo' },
    );
    expect(out.daily.map((d) => [d.date, d.receipts, d.harvester.raw.toString()])).toEqual([
      ['2026-09-10', 1, '70'],
      ['2026-09-11', 1, '70'],
    ]);
  });

  it('ignores other mosaics, other addresses and non-harvest receipts', () => {
    const out = aggregateHarvestIncome(
      [
        statement(10, T1, [
          receipt('70', ME, OTHER_MOSAIC),
          receipt('25', PEER, OTHER_MOSAIC),
          receipt('5', SINK, OTHER_MOSAIC),
        ]),
        statement(11, T1, [receipt('70', PEER), receipt('25', PEER), receipt('5', SINK)]),
        statement(12, T1, [
          { version: 1, type: INFLATION, mosaicId: XYM, amount: '100' },
          receipt('100', ME, XYM, 4685),
        ]),
      ],
      opts,
    );
    expect(out.rows).toEqual([]);
    expect(out.totals.receipts).toBe(0);
    expect(out.totals.raw).toBe(0n);
    expect(out.daily).toEqual([]);
  });

  it('keeps unknown-pattern receipts in the totals and counts the statements', () => {
    const out = aggregateHarvestIncome(
      [
        // Two receipts to the same account with no recognisable split.
        statement(20, T1, [receipt('9007199254740993', ME), receipt('9007199254740993', ME)]),
        statement(21, T2, [receipt('1', ME)]),
      ],
      opts,
    );
    // 2^53 + 1 twice: a Number sum would lose the low bit.
    expect(out.totals.raw.toString()).toBe('18014398509481987');
    expect(out.totals.unknown).toEqual({ receipts: 3, raw: 18014398509481987n });
    expect(out.unknownStatements).toBe(2);
  });

  it('compares addresses and mosaic ids case-insensitively', () => {
    const out = aggregateHarvestIncome(
      [
        statement(30, T1, [
          receipt('70', ME.toLowerCase(), XYM.toLowerCase()),
          receipt('25', PEER),
          receipt('5', SINK),
        ]),
      ],
      { ...opts, currencyMosaicId: XYM.toLowerCase() },
    );
    expect(out.totals.harvester.raw).toBe(70n);
  });
});

describe('height search', () => {
  // Block h has timestamp 30_000 * h; blocks 100..200 exist.
  const calls: number[] = [];
  const lookup = async (h: number) => {
    calls.push(h);
    if (h < 100 || h > 200) throw new Error(`no block ${h}`);
    return 30_000 * h;
  };
  it('finds the first block at or after an instant', async () => {
    expect(await firstHeightAtOrAfter(30_000 * 150, 100, 200, lookup)).toBe(150);
    expect(await firstHeightAtOrAfter(30_000 * 150 + 1, 100, 200, lookup)).toBe(151);
    expect(await firstHeightAtOrAfter(30_000 * 150 - 1, 100, 200, lookup)).toBe(150);
    expect(await firstHeightAtOrAfter(0, 100, 200, lookup)).toBe(100);
    expect(await firstHeightAtOrAfter(30_000 * 200, 100, 200, lookup)).toBe(200);
    expect(await firstHeightAtOrAfter(30_000 * 200 + 1, 100, 200, lookup)).toBeNull();
  });
  it('finds the last block at or before an instant', async () => {
    expect(await lastHeightAtOrBefore(30_000 * 150, 100, 200, lookup)).toBe(150);
    expect(await lastHeightAtOrBefore(30_000 * 150 + 1, 100, 200, lookup)).toBe(150);
    expect(await lastHeightAtOrBefore(30_000 * 150 - 1, 100, 200, lookup)).toBe(149);
    expect(await lastHeightAtOrBefore(30_000 * 100, 100, 200, lookup)).toBe(100);
    expect(await lastHeightAtOrBefore(30_000 * 100 - 1, 100, 200, lookup)).toBeNull();
    expect(await lastHeightAtOrBefore(Number.MAX_SAFE_INTEGER, 100, 200, lookup)).toBe(200);
  });
  it('handles a single-block range and an empty range', async () => {
    expect(await firstHeightAtOrAfter(30_000 * 120, 120, 120, lookup)).toBe(120);
    expect(await lastHeightAtOrBefore(30_000 * 120, 120, 120, lookup)).toBe(120);
    expect(await firstHeightAtOrAfter(0, 121, 120, lookup)).toBeNull();
  });
  it('needs only O(log n) lookups', async () => {
    calls.length = 0;
    await firstHeightAtOrAfter(30_000 * 137, 100, 200, lookup);
    expect(calls.length).toBeLessThanOrEqual(9);
  });
});
