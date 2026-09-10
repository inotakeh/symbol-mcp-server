import { describe, expect, it } from 'vitest';
import { formatAmount } from '../../src/domain/amount.js';

describe('formatAmount', () => {
  it('formats XYM (divisibility 6)', () => {
    expect(formatAmount('4321000000000', 6)).toBe('4321000.000000');
    expect(formatAmount('1000000', 6)).toBe('1.000000');
    expect(formatAmount('1', 6)).toBe('0.000001');
    expect(formatAmount('0', 6)).toBe('0.000000');
  });
  it('formats divisibility 0 and 3', () => {
    expect(formatAmount('1000', 0)).toBe('1000');
    expect(formatAmount('1234567', 3)).toBe('1234.567');
    expect(formatAmount(5n, 3)).toBe('0.005');
  });
  it('handles values above 2^53 exactly', () => {
    expect(formatAmount('18446744073709551615', 6)).toBe('18446744073709.551615');
  });
  it('formats negative bigint margins', () => {
    expect(formatAmount(-1_500_000n, 6)).toBe('-1.500000');
  });
  it('rejects malformed input', () => {
    expect(() => formatAmount('12.5', 6)).toThrow();
    expect(() => formatAmount('abc', 6)).toThrow();
    expect(() => formatAmount('1', -1)).toThrow();
  });
});
