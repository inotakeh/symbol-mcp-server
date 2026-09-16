import { describe, expect, it } from 'vitest';
import {
  assessClockSkew,
  assessFinalizationLag,
  assessStorage,
  computeClockSkewMs,
  deriveHealthVerdict,
  pickNodeTimestamp,
  skewThresholds,
  storageToleranceBlocks,
} from '../../src/domain/nodehealth.js';

/** Mainnet values from the fixture /network/properties. */
const BLOCK_TIME_MS = 30_000;
const G = 1440;
const EPOCH_ADJUSTMENT = 1_615_853_185;

describe('storageToleranceBlocks / assessStorage', () => {
  it('derives one minute worth of blocks from the block time', () => {
    expect(storageToleranceBlocks(30_000)).toBe(2);
    expect(storageToleranceBlocks(15_000)).toBe(4);
    expect(storageToleranceBlocks(60_000)).toBe(1);
    expect(storageToleranceBlocks(90_000)).toBe(1);
    expect(() => storageToleranceBlocks(0)).toThrow();
    expect(() => storageToleranceBlocks(-1)).toThrow();
  });
  it('flags a database that disagrees with the chain height beyond the tolerance', () => {
    expect(assessStorage(5_763_675, 5_763_675, BLOCK_TIME_MS)).toEqual({
      deltaBlocks: 0,
      toleranceBlocks: 2,
      status: 'ok',
    });
    expect(assessStorage(5_763_673, 5_763_675, BLOCK_TIME_MS).status).toBe('ok');
    expect(assessStorage(5_763_672, 5_763_675, BLOCK_TIME_MS)).toMatchObject({
      deltaBlocks: 3,
      status: 'warn',
    });
    // More blocks stored than the chain height is just as inconsistent.
    expect(assessStorage(5_763_680, 5_763_675, BLOCK_TIME_MS)).toMatchObject({
      deltaBlocks: 5,
      status: 'warn',
    });
  });
});

describe('clock skew', () => {
  it('prefers the send timestamp and falls back to receive', () => {
    expect(pickNodeTimestamp({ sendTimestamp: '10', receiveTimestamp: '9' })).toBe('10');
    expect(pickNodeTimestamp({ receiveTimestamp: '9' })).toBe('9');
    expect(pickNodeTimestamp({})).toBeNull();
  });
  it('computes the node clock minus the local clock', () => {
    // 2026-09-10T03:05:00Z is network time 173156315000 ms.
    const now = new Date('2026-09-10T03:05:00.000Z');
    expect(computeClockSkewMs('173156314000', EPOCH_ADJUSTMENT, now)).toBe(-1000);
    expect(computeClockSkewMs(173_156_316_500, EPOCH_ADJUSTMENT, now)).toBe(1500);
  });
  it('derives the thresholds from the block time and grades the magnitude', () => {
    expect(skewThresholds(BLOCK_TIME_MS)).toEqual({ warnMs: 15_000, failMs: 30_000 });
    expect(assessClockSkew(0, BLOCK_TIME_MS)).toBe('ok');
    expect(assessClockSkew(14_999, BLOCK_TIME_MS)).toBe('ok');
    expect(assessClockSkew(-14_999, BLOCK_TIME_MS)).toBe('ok');
    expect(assessClockSkew(15_000, BLOCK_TIME_MS)).toBe('warn');
    expect(assessClockSkew(-15_000, BLOCK_TIME_MS)).toBe('warn');
    expect(assessClockSkew(29_999, BLOCK_TIME_MS)).toBe('warn');
    expect(assessClockSkew(30_000, BLOCK_TIME_MS)).toBe('fail');
    expect(assessClockSkew(-30_000, BLOCK_TIME_MS)).toBe('fail');
    expect(assessClockSkew(7_500, 15_000)).toBe('warn');
  });
});

describe('assessFinalizationLag', () => {
  it('measures the fixture lag in blocks and minutes', () => {
    expect(assessFinalizationLag(5_763_675, 5_763_656, G, BLOCK_TIME_MS)).toEqual({
      lagBlocks: 19,
      lagMinutes: 9.5,
      warnBlocks: 720,
      failBlocks: 1440,
      status: 'ok',
    });
  });
  it('grades against half an epoch and a whole epoch', () => {
    expect(assessFinalizationLag(10_000, 10_000 - 719, G, BLOCK_TIME_MS).status).toBe('ok');
    expect(assessFinalizationLag(10_000, 10_000 - 720, G, BLOCK_TIME_MS).status).toBe('warn');
    expect(assessFinalizationLag(10_000, 10_000 - 1439, G, BLOCK_TIME_MS).status).toBe('warn');
    expect(assessFinalizationLag(10_000, 10_000 - 1440, G, BLOCK_TIME_MS)).toMatchObject({
      lagBlocks: 1440,
      lagMinutes: 720,
      status: 'fail',
    });
  });
  it('never reports a negative lag', () => {
    expect(assessFinalizationLag(100, 200, G, BLOCK_TIME_MS)).toMatchObject({
      lagBlocks: 0,
      status: 'ok',
    });
    expect(() => assessFinalizationLag(1, 1, 0, BLOCK_TIME_MS)).toThrow();
  });
});

describe('deriveHealthVerdict', () => {
  const s = (...statuses: Array<'ok' | 'warn' | 'fail' | 'unknown'>) =>
    statuses.map((status) => ({ status }));
  it('folds check statuses into one verdict', () => {
    expect(deriveHealthVerdict(s('ok', 'ok'))).toBe('healthy');
    expect(deriveHealthVerdict(s('ok', 'warn'))).toBe('degraded');
    expect(deriveHealthVerdict(s('ok', 'unknown'))).toBe('degraded');
    expect(deriveHealthVerdict(s('warn', 'fail', 'unknown'))).toBe('unhealthy');
    expect(deriveHealthVerdict([])).toBe('healthy');
  });
});
