import { describe, expect, it } from 'vitest';
import {
  CURRENCY_DECIMALS,
  currencyDecimals,
  DEFAULT_CURRENCY_DECIMALS,
  formatScaled,
  MAX_PRICE_DECIMALS,
  multiplyAndRound,
  PriceParseError,
  parseCurrencyCode,
  parseDecimalString,
  roundScaled,
} from '../../src/domain/price.js';

describe('parseDecimalString', () => {
  it('parses plain decimals into an integer and a scale', () => {
    expect(parseDecimalString('12.34')).toEqual({
      scaled: 1234n,
      decimals: 2,
      normalized: '12.34',
    });
    expect(parseDecimalString('1200')).toEqual({ scaled: 1200n, decimals: 0, normalized: '1200' });
    expect(parseDecimalString('0.0000123')).toEqual({
      scaled: 123n,
      decimals: 7,
      normalized: '0.0000123',
    });
    expect(parseDecimalString('1')).toEqual({ scaled: 1n, decimals: 0, normalized: '1' });
  });

  it('strips leading zeros of the integer part and trailing zeros of the fraction', () => {
    expect(parseDecimalString('012.340')).toEqual({
      scaled: 1234n,
      decimals: 2,
      normalized: '12.34',
    });
    expect(parseDecimalString('0012')).toEqual({ scaled: 12n, decimals: 0, normalized: '12' });
    expect(parseDecimalString('12.000')).toEqual({ scaled: 12n, decimals: 0, normalized: '12' });
    expect(parseDecimalString('0.50')).toEqual({ scaled: 5n, decimals: 1, normalized: '0.5' });
    expect(parseDecimalString('00.5')).toEqual({ scaled: 5n, decimals: 1, normalized: '0.5' });
  });

  it('accepts exactly 12 fractional digits', () => {
    const twelve = `0.${'0'.repeat(11)}1`;
    expect(parseDecimalString(twelve)).toEqual({
      scaled: 1n,
      decimals: MAX_PRICE_DECIMALS,
      normalized: twelve,
    });
  });

  it.each([
    ['1e3', /not a plain decimal/],
    ['1,200', /not a plain decimal/],
    ['¥12', /not a plain decimal/],
    ['$12', /not a plain decimal/],
    ['-1', /not a plain decimal/],
    ['+1', /not a plain decimal/],
    ['', /is empty/],
    ['12.', /not a plain decimal/],
    ['.5', /not a plain decimal/],
    [' 12', /not a plain decimal/],
    ['12 ', /not a plain decimal/],
    ['1.2.3', /not a plain decimal/],
    ['0', /is zero/],
    ['0.000', /is zero/],
    [`0.${'0'.repeat(12)}1`, /13 fractional digits; at most 12/],
    [`1${'0'.repeat(40)}`, /longer than 40 characters/],
  ])('rejects %j with a hint', (input, pattern) => {
    expect(() => parseDecimalString(input)).toThrow(PriceParseError);
    expect(() => parseDecimalString(input)).toThrow(pattern);
    // Every rejection also tells the caller the accepted form.
    expect(() => parseDecimalString(input)).toThrow(/positive|plain positive decimal string/);
  });
});

describe('parseCurrencyCode', () => {
  it('accepts 3 to 6 upper-case letters', () => {
    for (const code of ['JPY', 'USD', 'BTC', 'USDT', 'ABCDEF']) {
      expect(parseCurrencyCode(code)).toBe(code);
    }
  });

  it.each(['jpy', 'Jpy', 'JP', 'ABCDEFG', 'JP1', 'J PY', '', '¥', 'USD ', 'XYM/JPY'])(
    'rejects %j',
    (code) => {
      expect(() => parseCurrencyCode(code)).toThrow(PriceParseError);
      expect(() => parseCurrencyCode(code)).toThrow(/3 to 6 upper-case letters/);
    },
  );
});

describe('currencyDecimals', () => {
  it('uses the table for listed currencies and the default otherwise', () => {
    expect(CURRENCY_DECIMALS).toEqual({ JPY: 0, KRW: 0 });
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('KRW')).toBe(0);
    expect(currencyDecimals('USD')).toBe(DEFAULT_CURRENCY_DECIMALS);
    expect(currencyDecimals('BTC')).toBe(2);
    expect(currencyDecimals('XXXXXX')).toBe(2);
  });

  it('does not fall through to Object.prototype', () => {
    expect(currencyDecimals('constructor')).toBe(DEFAULT_CURRENCY_DECIMALS);
    expect(currencyDecimals('toString')).toBe(DEFAULT_CURRENCY_DECIMALS);
  });
});

describe('formatScaled', () => {
  it('writes a scaled integer as fixed point', () => {
    expect(formatScaled(1234n, 2)).toBe('12.34');
    expect(formatScaled(5n, 0)).toBe('5');
    expect(formatScaled(5n, 3)).toBe('0.005');
    expect(formatScaled(0n, 2)).toBe('0.00');
    expect(formatScaled(123n, 20)).toBe('0.00000000000000000123');
  });

  it('rejects negatives and bad decimals', () => {
    expect(() => formatScaled(-1n, 2)).toThrow(RangeError);
    expect(() => formatScaled(1n, -1)).toThrow(RangeError);
    expect(() => formatScaled(1n, 1.5)).toThrow(RangeError);
  });
});

describe('roundScaled', () => {
  it('rounds half up when dropping digits', () => {
    expect(roundScaled(12345n, 3, 2)).toBe(1235n); // 12.345 -> 12.35
    expect(roundScaled(12344n, 3, 2)).toBe(1234n); // 12.344 -> 12.34
    expect(roundScaled(5n, 1, 0)).toBe(1n); // 0.5 -> 1
    expect(roundScaled(4n, 1, 0)).toBe(0n); // 0.4 -> 0
    expect(roundScaled(15n, 1, 0)).toBe(2n); // 1.5 -> 2 (half up, not banker's)
    expect(roundScaled(25n, 1, 0)).toBe(3n); // 2.5 -> 3
  });

  it('pads when adding digits and keeps the value when scales match', () => {
    expect(roundScaled(12n, 0, 2)).toBe(1200n);
    expect(roundScaled(1234n, 2, 2)).toBe(1234n);
  });

  it('rejects negatives and bad scales', () => {
    expect(() => roundScaled(-1n, 2, 0)).toThrow(RangeError);
    expect(() => roundScaled(1n, -1, 0)).toThrow(RangeError);
    expect(() => roundScaled(1n, 2, -1)).toThrow(RangeError);
  });
});

describe('multiplyAndRound', () => {
  it('values 9,111,457.601413 XYM at 12.34 JPY (0 decimals)', () => {
    const out = multiplyAndRound(9_111_457_601_413n, 6, parseDecimalString('12.34'), 0);
    expect(out).toEqual({
      exact: '112435386.80143642',
      amount: '112435387',
      exactDecimals: 8,
    });
  });

  it('values the same balance in USD with 2 decimals', () => {
    const out = multiplyAndRound(9_111_457_601_413n, 6, parseDecimalString('0.0312'), 2);
    // 9111457.601413 x 0.0312 = 284277.477164...
    expect(out).toEqual({
      exact: '284277.4771640856',
      amount: '284277.48',
      exactDecimals: 10,
    });
  });

  it('handles a small unit price such as BTC', () => {
    const out = multiplyAndRound(4_321_000_000_000n, 6, parseDecimalString('0.0000123'), 2);
    expect(out).toEqual({ exact: '53.1483000000000', amount: '53.15', exactDecimals: 13 });
  });

  it('rounds an exact .5 up', () => {
    // 1.5 XYM x 1 JPY = 1.5 -> 2 JPY.
    expect(multiplyAndRound(1_500_000n, 6, parseDecimalString('1'), 0).amount).toBe('2');
    // 0.125 x 1 = 0.125 -> 0.13 at 2 decimals.
    expect(multiplyAndRound(125_000n, 6, parseDecimalString('1'), 2).amount).toBe('0.13');
    // 2.5 x 1 = 2.5 -> 3 (not banker's rounding).
    expect(multiplyAndRound(2_500_000n, 6, parseDecimalString('1'), 0).amount).toBe('3');
  });

  it('pads when the currency has more decimals than the product', () => {
    // Divisibility 0 mosaic at an integer price: exact has no decimals, amount is padded.
    const out = multiplyAndRound(7n, 0, parseDecimalString('3'), 2);
    expect(out).toEqual({ exact: '21', amount: '21.00', exactDecimals: 0 });
  });

  it('is exact for a zero balance', () => {
    const out = multiplyAndRound(0n, 6, parseDecimalString('12.34'), 0);
    expect(out).toEqual({ exact: '0.00000000', amount: '0', exactDecimals: 8 });
  });

  it('rejects negative balances and bad divisibility', () => {
    const price = parseDecimalString('1');
    expect(() => multiplyAndRound(-1n, 6, price, 0)).toThrow(RangeError);
    expect(() => multiplyAndRound(1n, -1, price, 0)).toThrow(RangeError);
    expect(() => multiplyAndRound(1n, 1.5, price, 0)).toThrow(RangeError);
  });
});
