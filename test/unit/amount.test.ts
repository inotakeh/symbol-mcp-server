import { describe, expect, it } from 'vitest';
import { formatAmount, groupThousands } from '../../src/domain/amount.js';

describe('groupThousands', () => {
  it('groups the integer part only', () => {
    expect(groupThousands('23237.845492')).toBe('23,237.845492');
    expect(groupThousands('662.574177')).toBe('662.574177');
    expect(groupThousands('1234567')).toBe('1,234,567');
    expect(groupThousands('0.000000')).toBe('0.000000');
    expect(groupThousands('-1500000.5')).toBe('-1,500,000.5');
    expect(groupThousands('18446744073709.551615')).toBe('18,446,744,073,709.551615');
  });
  it('rejects anything that is not a formatted amount', () => {
    expect(() => groupThousands('abc')).toThrow();
    expect(() => groupThousands('1,000')).toThrow();
  });
});

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
