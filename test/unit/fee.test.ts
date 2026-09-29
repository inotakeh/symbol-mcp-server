import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MESSAGE_BYTES,
  DEFAULT_TRANSFER_SIZE_BYTES,
  estimateFees,
  transferSizeBytes,
} from '../../src/domain/fee.js';

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
    // 20 ASCII characters are 20 UTF-8 bytes, plus the type byte.
    expect(DEFAULT_MESSAGE_BYTES).toBe(1 + Buffer.byteLength('x'.repeat(20), 'utf8'));
  });
  it('counts a transfer as 160 bytes, 16 per mosaic and the message in UTF-8 bytes plus 1', () => {
    // The captured mainnet transfer: 1 mosaic, no message.
    expect(transferSizeBytes(1, null)).toBe(176);
    expect(transferSizeBytes(0, null)).toBe(160);
    expect(transferSizeBytes(3, null)).toBe(208);
    // An empty plain message still has its type byte.
    expect(transferSizeBytes(1, 0)).toBe(177);
    // Japanese is 3 bytes a character in UTF-8: 20 characters are 60 bytes, not 20.
    const japanese = String.fromCodePoint(0x3042).repeat(20);
    expect(japanese.length).toBe(20);
    expect(transferSizeBytes(1, Buffer.byteLength(japanese, 'utf8'))).toBe(237);
  });
  it('rejects non-positive sizes', () => {
    expect(() => estimateFees(0, MULTIPLIERS, 6)).toThrow();
    expect(() => estimateFees(1.5, MULTIPLIERS, 6)).toThrow();
  });
});
