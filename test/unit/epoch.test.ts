import { describe, expect, it } from 'vitest';
import {
  epochEndHeight,
  epochStartHeight,
  heightToEpoch,
  parseHeight,
  votingKeyExpiryHeight,
} from '../../src/domain/epoch.js';

const G = 1440;

describe('heightToEpoch (mainnet data points)', () => {
  it('matches observed finalized heights', () => {
    expect(heightToEpoch(5_755_504, G)).toBe(3998);
    expect(heightToEpoch(5_763_316, G)).toBe(4004);
    expect(heightToEpoch(5_763_656, G)).toBe(4004);
  });
  it('handles epoch boundaries', () => {
    // epoch 4004 covers (4004-2)*1440+1 .. (4004-1)*1440 = 5762881 .. 5764320
    expect(heightToEpoch(5_762_881, G)).toBe(4004);
    expect(heightToEpoch(5_762_880, G)).toBe(4003);
    expect(heightToEpoch(5_764_320, G)).toBe(4004);
    expect(heightToEpoch(5_764_321, G)).toBe(4005);
  });
  it('treats height 1 as epoch 1 and height 2 as epoch 2', () => {
    expect(heightToEpoch(1, G)).toBe(1);
    expect(heightToEpoch(2, G)).toBe(2);
    expect(heightToEpoch(G, G)).toBe(2);
    expect(heightToEpoch(G + 1, G)).toBe(3);
  });
});

describe('epoch -> heights', () => {
  it('inverts heightToEpoch', () => {
    expect(epochStartHeight(4004, G)).toBe(5_762_881);
    expect(epochEndHeight(4004, G)).toBe(5_764_320);
    expect(epochStartHeight(1, G)).toBe(1);
    expect(epochEndHeight(1, G)).toBe(1);
    expect(epochStartHeight(2, G)).toBe(2);
    expect(epochEndHeight(2, G)).toBe(G);
    for (const e of [2, 3, 3998, 4059]) {
      expect(heightToEpoch(epochStartHeight(e, G), G)).toBe(e);
      expect(heightToEpoch(epochEndHeight(e, G), G)).toBe(e);
    }
  });
  it('computes voting key expiry height (E-1)*G', () => {
    expect(votingKeyExpiryHeight(4059, G)).toBe(5_843_520);
    expect(votingKeyExpiryHeight(3699, G)).toBe(5_325_120);
  });
  it('rejects invalid input', () => {
    expect(() => heightToEpoch(0, G)).toThrow();
    expect(() => heightToEpoch(10, 0)).toThrow();
    expect(() => epochStartHeight(0, G)).toThrow();
  });
});

describe('parseHeight', () => {
  it('parses REST uint64 strings', () => {
    expect(parseHeight('5763675')).toBe(5_763_675);
    expect(parseHeight(12)).toBe(12);
  });
  it('rejects non-integers', () => {
    expect(() => parseHeight('abc')).toThrow();
    expect(() => parseHeight('-1')).toThrow();
    expect(() => parseHeight('99999999999999999999')).toThrow();
  });
});
