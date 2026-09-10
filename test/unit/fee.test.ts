import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSFER_SIZE_BYTES, estimateFees } from '../../src/domain/fee.js';

const MULTIPLIERS = {
  minFeeMultiplier: 100,
  averageFeeMultiplier: 108,
  medianFeeMultiplier: 100,
  highestFeeMultiplier: 1136,
};

describe('estimateFees', () => {
  it('multiplies size by each multiplier and formats with divisibility 6', () => {
    const est = estimateFees(176, MULTIPLIERS, 6);
    expect(est.sizeBytes).toBe(176);
    expect(est.slow).toEqual({ multiplier: 100, rawFee: '17600', fee: '0.017600' });
    expect(est.average).toEqual({ multiplier: 108, rawFee: '19008', fee: '0.019008' });
    expect(est.median).toEqual({ multiplier: 100, rawFee: '17600', fee: '0.017600' });
    // The captured mainnet transfer (176 bytes, multiplier 1136) paid 0.199936 XYM.
    expect(est.fast).toEqual({ multiplier: 1136, rawFee: '199936', fee: '0.199936' });
  });
  it('uses the documented default transfer size', () => {
    expect(DEFAULT_TRANSFER_SIZE_BYTES).toBe(197);
  });
  it('rejects non-positive sizes', () => {
    expect(() => estimateFees(0, MULTIPLIERS, 6)).toThrow();
    expect(() => estimateFees(1.5, MULTIPLIERS, 6)).toThrow();
  });
});
