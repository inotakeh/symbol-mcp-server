import { describe, expect, it } from 'vitest';
import { Uint64String } from '../../src/client/schemas.js';

const accepts = (value: unknown) => Uint64String.safeParse(value).success;

describe('Uint64String', () => {
  it('accepts every uint64, up to 18446744073709551615', () => {
    for (const value of ['0', '1', '173135863808', '9007199254740993', '18446744073709551615']) {
      expect(accepts(value), value).toBe(true);
    }
    // catapult-rest writes no leading zero; up to 20 digits, such a value is still a uint64.
    expect(accepts('0'.repeat(20))).toBe(true);
  });

  it('refuses a number that does not fit in 64 bits', () => {
    for (const value of [
      '18446744073709551616', // 2^64
      '99999999999999999999', // 20 digits, above 2^64 - 1
      `1${'0'.repeat(20)}`, // 21 digits
      '0'.repeat(21), // 21 digits, though the value would fit
      '9'.repeat(400),
    ]) {
      expect(accepts(value), value).toBe(false);
    }
  });

  it('refuses a value of millions of digits, which the response cap allows', () => {
    expect(accepts('7'.repeat(4_000_000))).toBe(false);
  });

  it('refuses anything but a string of decimal digits', () => {
    const fullWidthOne = String.fromCodePoint(0xff11);
    for (const value of ['', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '0x10', 'ten', fullWidthOne]) {
      expect(accepts(value), value).toBe(false);
    }
    expect(accepts(1)).toBe(false);
  });
});
