import { describe, expect, it } from 'vitest';
import type { Receipt, TransactionStatementInfo } from '../../src/client/schemas.js';
import {
  aggregateHarvestIncome,
  blocksForDays,
  CHUNK_DAYS,
  classifyHarvestReceipts,
  firstHeightAtOrAfter,
  lastHeightAtOrBefore,
  MIN_CHUNK_DAYS,
  shrinkChunkBlocks,
  splitHeightRange,
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
      // Two beneficiary receipts, but only one of them is from a block someone else harvested.
      blocks: 2,
      blocksHarvested: 1,
      blocksBeneficiaryOnly: 1,
      blocksUnrecognised: 0,
      beneficiaryReceiptsInOwnBlocks: 1,
    });
    expect(out.unknownStatements).toBe(0);
    // Both blocks fall on 2026-09-10 in UTC.
    expect(out.daily.map((d) => [d.date, d.receipts, d.raw.toString()])).toEqual([
      ['2026-09-10', 3, '87852204'],
    ]);
  });

  it('counts each block once, by the role the account had in it', () => {
    const out = aggregateHarvestIncome(
      [
        // Harvested by ME, which is also the node's beneficiary: two receipts, one block.
        statement(40, T1, [receipt('70', ME), receipt('25', ME), receipt('5', SINK)]),
        // Harvested by PEER on a node that names ME as beneficiary: beneficiary share only.
        statement(41, T1, [receipt('70', PEER), receipt('25', ME), receipt('5', SINK)]),
        // Harvested by ME without a beneficiary share, (100-N):N.
        statement(42, T1, [receipt('95', ME), receipt('5', SINK)]),
        // Split not recognised (60/35/5): counted as a block, but in neither role.
        statement(43, T1, [receipt('60', ME), receipt('35', PEER), receipt('5', SINK)]),
      ],
      opts,
    );
    expect(out.totals).toMatchObject({
      receipts: 5,
      harvester: { receipts: 2, raw: 165n },
      beneficiary: { receipts: 2, raw: 50n },
      unknown: { receipts: 1, raw: 60n },
      blocks: 4,
      blocksHarvested: 2,
      blocksBeneficiaryOnly: 1,
      // Every block in exactly one role; the beneficiary receipt of block 40 is from its own block.
      blocksUnrecognised: 1,
      beneficiaryReceiptsInOwnBlocks: 1,
    });
    expect(out.unknownStatements).toBe(1);
    expect(out.daily).toHaveLength(1);
    expect(out.daily[0]).toMatchObject({
      blocks: 4,
      blocksHarvested: 2,
      blocksBeneficiaryOnly: 1,
      blocksUnrecognised: 1,
      beneficiaryReceiptsInOwnBlocks: 1,
    });
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

  describe('monthly buckets', () => {
    // Network timestamp (ms since nemesis) of a wall-clock instant.
    const at = (iso: string) => String(Date.parse(iso) - EPOCH_ADJUSTMENT * 1000);
    const statements = [
      // 2026-08-31 14:30 UTC = 2026-08-31 23:30 Asia/Tokyo: harvester share 70 to ME
      statement(100, at('2026-08-31T14:30:00Z'), [
        receipt('70', ME),
        receipt('25', PEER),
        receipt('5', SINK),
      ]),
      // 2026-08-31 15:30 UTC = 2026-09-01 00:30 Asia/Tokyo: beneficiary share 250 to ME
      statement(101, at('2026-08-31T15:30:00Z'), [
        receipt('700', PEER),
        receipt('250', ME),
        receipt('50', SINK),
      ]),
      // mid September in both zones: harvester share 7000 to ME
      statement(102, at('2026-09-15T00:00:00Z'), [
        receipt('7000', ME),
        receipt('2500', PEER),
        receipt('500', SINK),
      ]),
    ];
    const flat = (b: { receipts: number; raw: bigint; harvester: { raw: bigint } }) => [
      b.receipts,
      b.raw.toString(),
      b.harvester.raw.toString(),
    ];

    it('buckets by UTC month with fixed totals', () => {
      const out = aggregateHarvestIncome(statements, opts);
      expect(out.daily.map((d) => [d.date, ...flat(d)])).toEqual([
        ['2026-08-31', 2, '320', '70'],
        ['2026-09-15', 1, '7000', '7000'],
      ]);
      expect(out.monthly.map((m) => [m.month, ...flat(m)])).toEqual([
        ['2026-08', 2, '320', '70'],
        ['2026-09', 1, '7000', '7000'],
      ]);
      expect(out.monthly[0]?.beneficiary).toEqual({ receipts: 1, raw: 250n });
      expect(out.monthly[0]?.unknown).toEqual({ receipts: 0, raw: 0n });
    });

    it('follows the configured zone, moving the midnight receipt into the next month', () => {
      const out = aggregateHarvestIncome(statements, { ...opts, timeZone: 'Asia/Tokyo' });
      expect(out.daily.map((d) => [d.date, ...flat(d)])).toEqual([
        ['2026-08-31', 1, '70', '70'],
        ['2026-09-01', 1, '250', '0'],
        ['2026-09-15', 1, '7000', '7000'],
      ]);
      expect(out.monthly.map((m) => [m.month, ...flat(m)])).toEqual([
        ['2026-08', 1, '70', '70'],
        ['2026-09', 2, '7250', '7000'],
      ]);
      expect(out.monthly[1]?.beneficiary).toEqual({ receipts: 1, raw: 250n });
    });

    it('makes every month exactly the sum of its days, in ascending order', () => {
      for (const timeZone of [undefined, 'Asia/Tokyo', 'America/Los_Angeles']) {
        const out = aggregateHarvestIncome(statements, { ...opts, timeZone });
        const months = out.monthly.map((m) => m.month);
        expect([...months].sort()).toEqual(months);
        for (const m of out.monthly) {
          const days = out.daily.filter((d) => d.date.startsWith(`${m.month}-`));
          expect(days.length).toBeGreaterThan(0);
          const sum = (pick: (b: (typeof days)[number]) => bigint) =>
            days.reduce((acc, d) => acc + pick(d), 0n);
          expect(m.receipts).toBe(days.reduce((acc, d) => acc + d.receipts, 0));
          expect(m.raw).toBe(sum((d) => d.raw));
          expect(m.harvester.raw).toBe(sum((d) => d.harvester.raw));
          expect(m.beneficiary.raw).toBe(sum((d) => d.beneficiary.raw));
          expect(m.unknown.raw).toBe(sum((d) => d.unknown.raw));
          const count = (pick: (b: (typeof days)[number]) => number) =>
            days.reduce((acc, d) => acc + pick(d), 0);
          expect(m.blocks).toBe(count((d) => d.blocks));
          expect(m.blocksHarvested).toBe(count((d) => d.blocksHarvested));
          expect(m.blocksBeneficiaryOnly).toBe(count((d) => d.blocksBeneficiaryOnly));
          expect(m.blocksUnrecognised).toBe(count((d) => d.blocksUnrecognised));
          expect(m.beneficiaryReceiptsInOwnBlocks).toBe(
            count((d) => d.beneficiaryReceiptsInOwnBlocks),
          );
        }
        expect(out.monthly.reduce((acc, m) => acc + m.raw, 0n)).toBe(out.totals.raw);
        expect(out.monthly.reduce((acc, m) => acc + m.blocks, 0)).toBe(out.totals.blocks);
      }
    });

    it('is empty when there are no rows', () => {
      expect(aggregateHarvestIncome([], opts).monthly).toEqual([]);
    });
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
    expect(out.totals).toMatchObject({
      blocks: 2,
      blocksHarvested: 0,
      blocksBeneficiaryOnly: 0,
      blocksUnrecognised: 2,
    });
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

describe('blocksForDays', () => {
  it('derives the chunk lengths from the block time', () => {
    expect(CHUNK_DAYS).toBe(90);
    expect(MIN_CHUNK_DAYS).toBe(7);
    expect(blocksForDays(CHUNK_DAYS, 30_000)).toBe(259_200);
    expect(blocksForDays(MIN_CHUNK_DAYS, 30_000)).toBe(20_160);
    expect(blocksForDays(CHUNK_DAYS, 15_000)).toBe(518_400);
    expect(blocksForDays(CHUNK_DAYS, 60_000)).toBe(129_600);
  });
  it('rounds and never returns less than one block', () => {
    expect(blocksForDays(1, 7_000)).toBe(12_343);
    expect(blocksForDays(1, 10 * 86_400_000)).toBe(1);
  });
  it('rejects a block time or day count that is not positive', () => {
    for (const bad of [0, -30_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => blocksForDays(90, bad)).toThrow();
      expect(() => blocksForDays(bad, 30_000)).toThrow();
    }
  });
});

describe('splitHeightRange', () => {
  it('splits an evenly divisible range', () => {
    expect(splitHeightRange(1, 300, 100)).toEqual([
      { fromHeight: 1, toHeight: 100 },
      { fromHeight: 101, toHeight: 200 },
      { fromHeight: 201, toHeight: 300 },
    ]);
  });
  it('puts the remainder in the last range', () => {
    expect(splitHeightRange(1, 250, 100)).toEqual([
      { fromHeight: 1, toHeight: 100 },
      { fromHeight: 101, toHeight: 200 },
      { fromHeight: 201, toHeight: 250 },
    ]);
  });
  it('handles one-block chunks and a one-block range', () => {
    expect(splitHeightRange(7, 9, 1)).toEqual([
      { fromHeight: 7, toHeight: 7 },
      { fromHeight: 8, toHeight: 8 },
      { fromHeight: 9, toHeight: 9 },
    ]);
    expect(splitHeightRange(42, 42, 100)).toEqual([{ fromHeight: 42, toHeight: 42 }]);
    expect(splitHeightRange(42, 42, 1)).toEqual([{ fromHeight: 42, toHeight: 42 }]);
  });
  it('keeps a range up to the chunk length whole and splits one block more', () => {
    expect(splitHeightRange(500, 549, 100)).toEqual([{ fromHeight: 500, toHeight: 549 }]);
    expect(splitHeightRange(500, 599, 100)).toEqual([{ fromHeight: 500, toHeight: 599 }]);
    expect(splitHeightRange(500, 600, 100)).toEqual([
      { fromHeight: 500, toHeight: 599 },
      { fromHeight: 600, toHeight: 600 },
    ]);
  });
  it('covers a year of mainnet blocks in five ranges without overlap or gap', () => {
    const from = 4_700_000;
    const to = from + 1_051_200 - 1;
    const ranges = splitHeightRange(from, to, 259_200);
    expect(ranges).toHaveLength(5);
    expect(ranges[0]?.fromHeight).toBe(from);
    expect(ranges.at(-1)?.toHeight).toBe(to);
    ranges.slice(1).forEach((r, i) => {
      expect(r.fromHeight).toBe((ranges[i]?.toHeight ?? Number.NaN) + 1);
    });
    expect(ranges.reduce((n, r) => n + (r.toHeight - r.fromHeight + 1), 0)).toBe(1_051_200);
    expect(ranges.at(-1)).toEqual({ fromHeight: from + 4 * 259_200, toHeight: to });
  });
  it('rejects a reversed range, fractions and a chunk length below one', () => {
    expect(() => splitHeightRange(10, 9, 100)).toThrow(RangeError);
    expect(() => splitHeightRange(1.5, 9, 100)).toThrow(RangeError);
    expect(() => splitHeightRange(1, 9.5, 100)).toThrow(RangeError);
    expect(() => splitHeightRange(1, 9, 0)).toThrow(RangeError);
    expect(() => splitHeightRange(1, 9, 2.5)).toThrow(RangeError);
    expect(() => splitHeightRange(1, 9, Number.NaN)).toThrow(RangeError);
  });
});

describe('shrinkChunkBlocks', () => {
  it('halves, rounding up', () => {
    expect(shrinkChunkBlocks(259_200, 20_160)).toBe(129_600);
    expect(shrinkChunkBlocks(129_600, 20_160)).toBe(64_800);
    expect(shrinkChunkBlocks(64_800, 20_160)).toBe(32_400);
    expect(shrinkChunkBlocks(101, 10)).toBe(51);
  });
  it('stops at the minimum instead of going below it', () => {
    expect(shrinkChunkBlocks(32_400, 20_160)).toBe(20_160);
    expect(shrinkChunkBlocks(20_161, 20_160)).toBe(20_160);
  });
  it('returns null at or below the minimum', () => {
    expect(shrinkChunkBlocks(20_160, 20_160)).toBeNull();
    expect(shrinkChunkBlocks(13_200, 20_160)).toBeNull();
    expect(shrinkChunkBlocks(1, 1)).toBeNull();
  });
  it('rejects lengths that are not positive integers', () => {
    expect(() => shrinkChunkBlocks(0, 10)).toThrow(RangeError);
    expect(() => shrinkChunkBlocks(10.5, 10)).toThrow(RangeError);
    expect(() => shrinkChunkBlocks(100, 0)).toThrow(RangeError);
  });
});
