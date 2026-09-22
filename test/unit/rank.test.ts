import { describe, expect, it } from 'vitest';
import {
  HOLDER_PAGE_SIZE,
  mosaicBalanceOf,
  pagesToScan,
  percentOfSupply,
  rankOf,
} from '../../src/domain/rank.js';

describe('percentOfSupply', () => {
  it('formats a share of supply with 4 decimals using integer arithmetic', () => {
    expect(percentOfSupply(1n, 3n)).toBe('33.3333');
    expect(percentOfSupply(2n, 3n)).toBe('66.6667');
    expect(percentOfSupply(1n, 1n)).toBe('100.0000');
    expect(percentOfSupply(0n, 5n)).toBe('0.0000');
    // The fixture account: 4,321,000 XYM of 7,842,928,625 XYM.
    expect(percentOfSupply(4_321_000_000_000n, 7_842_928_625_000_000n)).toBe('0.0551');
  });

  it('rounds half up at the last decimal', () => {
    expect(percentOfSupply(1n, 200_000n)).toBe('0.0005'); // exactly 0.0005 %
    expect(percentOfSupply(1n, 2_000_000n)).toBe('0.0001'); // 0.00005 % rounds up
    expect(percentOfSupply(1n, 3_000_000n)).toBe('0.0000'); // 0.000033 % rounds down
  });

  it('honours the decimals argument', () => {
    expect(percentOfSupply(1n, 8n, 0)).toBe('13');
    expect(percentOfSupply(1n, 8n, 1)).toBe('12.5');
    expect(percentOfSupply(1n, 8n, 6)).toBe('12.500000');
  });

  it('is null for a zero supply and rejects negative amounts', () => {
    expect(percentOfSupply(5n, 0n)).toBeNull();
    expect(() => percentOfSupply(-1n, 10n)).toThrow(RangeError);
    expect(() => percentOfSupply(1n, -10n)).toThrow(RangeError);
    expect(() => percentOfSupply(1n, 10n, -1)).toThrow(RangeError);
  });
});

describe('rankOf', () => {
  it('numbers rows across pages from 1', () => {
    expect(rankOf(1, 100, 0)).toBe(1);
    expect(rankOf(1, 100, 99)).toBe(100);
    expect(rankOf(2, 100, 0)).toBe(101);
    expect(rankOf(2, 100, 56)).toBe(157);
    expect(rankOf(10, 100, 99)).toBe(1000);
  });

  it('rejects invalid page numbers, sizes and indexes', () => {
    expect(() => rankOf(0, 100, 0)).toThrow(RangeError);
    expect(() => rankOf(1, 0, 0)).toThrow(RangeError);
    expect(() => rankOf(1, 100, -1)).toThrow(RangeError);
    expect(() => rankOf(1.5, 100, 0)).toThrow(RangeError);
  });
});

describe('pagesToScan', () => {
  it('is the ceiling of maxRank / pageSize', () => {
    expect(pagesToScan(100, 100)).toBe(1);
    expect(pagesToScan(101, 100)).toBe(2);
    expect(pagesToScan(1000, 100)).toBe(10);
    expect(pagesToScan(5000, 100)).toBe(50);
    expect(pagesToScan(1, 100)).toBe(1);
  });

  it('rejects zero and non-integers', () => {
    expect(() => pagesToScan(0, 100)).toThrow(RangeError);
    expect(() => pagesToScan(100, 0)).toThrow(RangeError);
    expect(() => pagesToScan(2.5, 100)).toThrow(RangeError);
  });
});

describe('mosaicBalanceOf', () => {
  const mosaics = [
    { id: '6BED913FA20223F8', amount: '4321000000000' },
    { id: '66BAE04E8758599E', amount: '1000000000' },
  ];

  it('returns the amount of the matching mosaic as a bigint, case-insensitively', () => {
    expect(mosaicBalanceOf(mosaics, '6BED913FA20223F8')).toBe(4_321_000_000_000n);
    expect(mosaicBalanceOf(mosaics, '6bed913fa20223f8')).toBe(4_321_000_000_000n);
    expect(mosaicBalanceOf(mosaics, '66BAE04E8758599E')).toBe(1_000_000_000n);
  });

  it('is 0n when the account holds none of the mosaic', () => {
    expect(mosaicBalanceOf(mosaics, '0000000000000001')).toBe(0n);
    expect(mosaicBalanceOf([], '6BED913FA20223F8')).toBe(0n);
  });
});

it('scans 100 holders per request (the REST maximum page size)', () => {
  expect(HOLDER_PAGE_SIZE).toBe(100);
});
