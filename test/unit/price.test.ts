import { describe, expect, it, vi } from 'vitest';
import {
  formatScaled,
  intlCurrencyDigits,
  MAX_PRICE_DECIMALS,
  MAX_ROUNDING_DECIMALS,
  multiplyAndRound,
  PriceParseError,
  parseCurrencyCode,
  parseDecimalString,
  parseRoundingDecimals,
  type RoundingRule,
  roundingRule,
  roundScaled,
  trimFraction,
} from '../../src/domain/price.js';

/** Where the currency digits come from, for the failure message when a Node build differs. */
const RUNTIME = `Node ${process.version}, ICU ${process.versions.icu}, CLDR ${process.versions.cldr}`;

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

describe('intlCurrencyDigits', () => {
  // Pinned on purpose: CI runs these on Node 22 and 24, so a Node (ICU / CLDR) whose digits for a
  // major currency differ from these fails here instead of changing amounts silently.
  it.each([
    ['JPY', 0],
    ['KRW', 0],
    ['USD', 2],
    ['EUR', 2],
    ['KWD', 3],
    ['BHD', 3],
    ['CLF', 4],
    ['XAU', 2], // Intl knows gold and gives it the CLDR default of 2 digits
  ])('gives %s %i digits', (code, digits) => {
    expect(intlCurrencyDigits(code), `${code} on ${RUNTIME}`).toBe(digits);
  });

  it.each(['BTC', 'ETH', 'XYM', 'USDT', 'ABCDEF'])('knows no digits for %s', (code) => {
    expect(intlCurrencyDigits(code), `${code} on ${RUNTIME}`).toBeNull();
  });

  it('knows no digits, without throwing, on a Node.js without Intl', () => {
    // CHF is used nowhere else in this file: the lookup below is not cached yet.
    vi.stubGlobal('Intl', undefined);
    let digits: number | null | undefined;
    try {
      digits = intlCurrencyDigits('CHF');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(digits).toBeNull();
    // Only codes Intl knows are cached, so the failed lookup is not remembered.
    expect(intlCurrencyDigits('CHF'), `CHF on ${RUNTIME}`).toBe(2);
  });
});

describe('roundingRule', () => {
  it("prefers the caller's decimals, then Intl's digits, then no rounding", () => {
    expect(roundingRule('USD', 4)).toEqual({ decimals: 4, source: 'caller' });
    expect(roundingRule('BTC', 8)).toEqual({ decimals: 8, source: 'caller' });
    expect(roundingRule('JPY', 0)).toEqual({ decimals: 0, source: 'caller' });
    expect(roundingRule('KWD')).toEqual({ decimals: 3, source: 'currency' });
    expect(roundingRule('BTC')).toEqual({ decimals: null, source: 'none' });
    expect(roundingRule('USDT')).toEqual({ decimals: null, source: 'none' });
  });
});

describe('parseRoundingDecimals', () => {
  it('accepts an integer from 0 to 12', () => {
    expect(parseRoundingDecimals(0)).toBe(0);
    expect(parseRoundingDecimals(MAX_ROUNDING_DECIMALS)).toBe(12);
  });

  it.each([-1, 13, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %j with a hint',
    (value) => {
      expect(() => parseRoundingDecimals(value)).toThrow(PriceParseError);
      expect(() => parseRoundingDecimals(value)).toThrow(/integer from 0 to 12/);
    },
  );
});

describe('trimFraction', () => {
  it('drops trailing fractional zeros only', () => {
    expect(trimFraction('0.0003000000000')).toBe('0.0003');
    expect(trimFraction('53.1483000000000')).toBe('53.1483');
    expect(trimFraction('21.00')).toBe('21');
    expect(trimFraction('1200')).toBe('1200');
    expect(trimFraction('0.000')).toBe('0');
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
  /** A rule as roundingRule would give it for a known currency (or the caller). */
  const currency = (decimals: number): RoundingRule => ({ decimals, source: 'currency' });
  const none: RoundingRule = { decimals: null, source: 'none' };

  it('values 9,111,457.601413 XYM at 12.34 JPY (0 decimals)', () => {
    const out = multiplyAndRound(9_111_457_601_413n, 6, parseDecimalString('12.34'), currency(0));
    expect(out).toEqual({
      exact: '112435386.80143642',
      exactDecimals: 8,
      amount: '112435387',
      roundingDecimals: 0,
      decimalsSource: 'currency',
    });
  });

  it('values the same balance in USD with 2 decimals', () => {
    const out = multiplyAndRound(9_111_457_601_413n, 6, parseDecimalString('0.0312'), currency(2));
    // 9111457.601413 x 0.0312 = 284277.477164...
    expect(out).toEqual({
      exact: '284277.4771640856',
      exactDecimals: 10,
      amount: '284277.48',
      roundingDecimals: 2,
      decimalsSource: 'currency',
    });
  });

  it('rounds half up at 3 and 4 decimals (KWD, BHD, CLF)', () => {
    const balance = 4_321_000_000_000n; // 4,321,000 XYM
    const at = (price: string, decimals: number) =>
      multiplyAndRound(balance, 6, parseDecimalString(price), currency(decimals)).amount;
    expect(at('0.0012', 3)).toBe('5185.200');
    expect(at('0.0012345', 3)).toBe('5334.275'); // 5334.2745 -> 5334.275
    expect(at('0.00003456', 4)).toBe('149.3338'); // 149.33376 -> 149.3338
  });

  it('keeps every digit, without trailing zeros, when there is no rounding (BTC)', () => {
    const out = multiplyAndRound(4_321_000_000_000n, 6, parseDecimalString('0.0000123'), none);
    expect(out).toEqual({
      exact: '53.1483000000000',
      exactDecimals: 13,
      amount: '53.1483',
      roundingDecimals: null,
      decimalsSource: 'none',
    });
    // 1,000 XYM x 0.0000003 BTC = 0.0003 BTC, which a fixed 2 decimals would show as 0.00.
    const small = multiplyAndRound(1_000_000_000n, 6, parseDecimalString('0.0000003'), none);
    expect(small).toEqual({
      exact: '0.0003000000000',
      exactDecimals: 13,
      amount: '0.0003',
      roundingDecimals: null,
      decimalsSource: 'none',
    });
  });

  it('leaves a non-zero value unrounded when rounding would show it as 0', () => {
    // 4,321,000 XYM x 0.000000001 XAU = 0.004321 XAU, which is 0.00 at the 2 digits Intl gives XAU.
    const price = parseDecimalString('0.000000001');
    const gold = multiplyAndRound(4_321_000_000_000n, 6, price, currency(2));
    expect(gold).toEqual({
      exact: '0.004321000000000',
      exactDecimals: 15,
      amount: '0.004321',
      roundingDecimals: null,
      decimalsSource: 'rounds_to_zero',
    });
    // The caller's decimals get the same safety net.
    const asked = multiplyAndRound(4_321_000_000_000n, 6, price, { decimals: 2, source: 'caller' });
    expect(asked).toMatchObject({ amount: '0.004321', decimalsSource: 'rounds_to_zero' });
    // 0.005 rounds half up to 0.01: not zero, so it is rounded.
    const half = multiplyAndRound(5_000n, 6, parseDecimalString('1'), currency(2));
    expect(half).toMatchObject({ amount: '0.01', roundingDecimals: 2, decimalsSource: 'currency' });
    // A zero balance is 0, rounded as usual.
    const zero = multiplyAndRound(0n, 6, price, currency(2));
    expect(zero).toMatchObject({ amount: '0.00', roundingDecimals: 2, decimalsSource: 'currency' });
  });

  it('stays exact for the largest values (BigInt)', () => {
    // 8,999,999,999.999999 XYM x 999,999,999,999.999999999999 JPY (checked with Python Decimal).
    const out = multiplyAndRound(
      8_999_999_999_999_999n,
      6,
      parseDecimalString('999999999999.999999999999'),
      currency(0),
    );
    expect(out).toMatchObject({
      exact: '8999999999999998999999.991000000000000001',
      exactDecimals: 18,
      amount: '8999999999999999000000',
    });
  });

  it('rounds an exact .5 up', () => {
    const one = parseDecimalString('1');
    // 1.5 XYM x 1 JPY = 1.5 -> 2 JPY.
    expect(multiplyAndRound(1_500_000n, 6, one, currency(0)).amount).toBe('2');
    // 0.125 x 1 = 0.125 -> 0.13 at 2 decimals.
    expect(multiplyAndRound(125_000n, 6, one, currency(2)).amount).toBe('0.13');
    // 2.5 x 1 = 2.5 -> 3 (not banker's rounding).
    expect(multiplyAndRound(2_500_000n, 6, one, currency(0)).amount).toBe('3');
  });

  it('pads when the currency has more decimals than the product', () => {
    // Divisibility 0 mosaic at an integer price: exact has no decimals, amount is padded.
    const out = multiplyAndRound(7n, 0, parseDecimalString('3'), currency(2));
    expect(out).toMatchObject({ exact: '21', exactDecimals: 0, amount: '21.00' });
  });

  it('is exact for a zero balance', () => {
    const out = multiplyAndRound(0n, 6, parseDecimalString('12.34'), currency(0));
    expect(out).toMatchObject({ exact: '0.00000000', exactDecimals: 8, amount: '0' });
  });

  it('rejects negative balances and bad divisibility', () => {
    const price = parseDecimalString('1');
    expect(() => multiplyAndRound(-1n, 6, price, currency(0))).toThrow(RangeError);
    expect(() => multiplyAndRound(1n, -1, price, currency(0))).toThrow(RangeError);
    expect(() => multiplyAndRound(1n, 1.5, price, currency(0))).toThrow(RangeError);
  });
});
