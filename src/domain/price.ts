/**
 * Pure arithmetic for symbol_holdings_value: a caller-supplied unit price as a decimal string,
 * a currency code, and balance x price in BigInt. No floating point anywhere: the price is kept
 * as an integer plus a number of decimal places, so `raw balance x scaled price` is exact and the
 * only rounding is the final half-up rounding to the currency's customary decimals.
 *
 * The server never fetches or validates a price (DESIGN-BRIEF §2-7: no traffic beyond the node);
 * everything here is arithmetic on values the caller passed in.
 */

/** Longest fractional part accepted for a unit price (policy constant). */
export const MAX_PRICE_DECIMALS = 12;

/** Longest unit price string accepted, before any normalisation (policy constant). */
export const MAX_PRICE_LENGTH = 40;

/**
 * Customary decimals per currency code for the rounded `value.amount`. Codes not listed round to
 * `DEFAULT_CURRENCY_DECIMALS`. Extend this table to add a currency; nothing else needs to change.
 */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
};
export const DEFAULT_CURRENCY_DECIMALS = 2;

const CURRENCY_CODE_PATTERN = /^[A-Z]{3,6}$/;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** Thrown for a price or currency the caller wrote in a form this tool does not accept. */
export class PriceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceParseError';
  }
}

export interface DecimalPrice {
  /** The price as an integer, scaled by 10^decimals. "12.34" -> 1234n. */
  readonly scaled: bigint;
  /** Number of fractional digits after normalisation. "12.34" -> 2, "1200" -> 0. */
  readonly decimals: number;
  /** Canonical spelling: no leading zeros in the integer part, no trailing zeros in the fraction. */
  readonly normalized: string;
}

const PRICE_FORM_HINT =
  'Write the unit price as a plain positive decimal string such as "12.34", "1200" or "0.0000123": digits with at most one dot, no exponent, no thousands separators, no currency symbol, no sign, and at most 12 fractional digits.';

/**
 * Parses a positive decimal string into an integer and a scale. "012.340" -> { 1234n, 2, "12.34" }.
 * Rejects exponents, separators, symbols, signs, a bare dot on either side, more than 12
 * fractional digits and zero.
 */
export function parseDecimalString(value: string): DecimalPrice {
  if (value.length === 0) {
    throw new PriceParseError(`unitPrice is empty. ${PRICE_FORM_HINT}`);
  }
  if (value.length > MAX_PRICE_LENGTH) {
    throw new PriceParseError(
      `unitPrice is longer than ${MAX_PRICE_LENGTH} characters. ${PRICE_FORM_HINT}`,
    );
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new PriceParseError(`unitPrice "${value}" is not a plain decimal. ${PRICE_FORM_HINT}`);
  }
  const integerDigits = match[1] ?? '';
  const fractionDigits = match[2] ?? '';
  if (fractionDigits.length > MAX_PRICE_DECIMALS) {
    throw new PriceParseError(
      `unitPrice "${value}" has ${fractionDigits.length} fractional digits; at most ${MAX_PRICE_DECIMALS} are accepted. ${PRICE_FORM_HINT}`,
    );
  }
  const integerPart = integerDigits.replace(/^0+(?=\d)/, '');
  const fractionPart = fractionDigits.replace(/0+$/, '');
  const scaled = BigInt(`${integerPart}${fractionPart}`);
  if (scaled === 0n) {
    throw new PriceParseError(`unitPrice "${value}" is zero; a positive price is required.`);
  }
  const normalized = fractionPart.length === 0 ? integerPart : `${integerPart}.${fractionPart}`;
  return { scaled, decimals: fractionPart.length, normalized };
}

/** Validates a currency code: 3 to 6 upper-case ASCII letters (JPY, USD, BTC, USDT). */
export function parseCurrencyCode(value: string): string {
  if (!CURRENCY_CODE_PATTERN.test(value)) {
    throw new PriceParseError(
      `currency "${value}" is not a currency code. Pass 3 to 6 upper-case letters such as JPY, USD or BTC.`,
    );
  }
  return value;
}

/** Decimals the rounded amount is shown with for a currency (CURRENCY_DECIMALS or the default). */
export function currencyDecimals(currency: string): number {
  return Object.hasOwn(CURRENCY_DECIMALS, currency)
    ? (CURRENCY_DECIMALS[currency] ?? DEFAULT_CURRENCY_DECIMALS)
    : DEFAULT_CURRENCY_DECIMALS;
}

/**
 * Writes an integer that is scaled by 10^decimals as a fixed-point string: formatScaled(1234n, 2)
 * -> "12.34", formatScaled(5n, 0) -> "5". Unlike domain/amount.ts formatAmount it has no upper
 * bound on `decimals` (balance divisibility + price decimals can exceed 18).
 */
export function formatScaled(value: bigint, decimals: number): string {
  if (value < 0n) throw new RangeError('value must be non-negative');
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError('decimals >= 0');
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0');
  return `${whole.toString()}.${frac}`;
}

/**
 * Rescales `value` (scaled by 10^fromDecimals) to 10^toDecimals, rounding half up when digits are
 * dropped and padding with zeros when digits are added.
 */
export function roundScaled(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (value < 0n) throw new RangeError('value must be non-negative');
  if (!Number.isInteger(fromDecimals) || fromDecimals < 0)
    throw new RangeError('fromDecimals >= 0');
  if (!Number.isInteger(toDecimals) || toDecimals < 0) throw new RangeError('toDecimals >= 0');
  if (toDecimals >= fromDecimals) return value * 10n ** BigInt(toDecimals - fromDecimals);
  const unit = 10n ** BigInt(fromDecimals - toDecimals);
  return (value + unit / 2n) / unit;
}

export interface HoldingsValue {
  /** balance x price with every digit: divisibility + price decimals fractional digits. */
  readonly exact: string;
  /** The same value rounded half up to `decimals` fractional digits. */
  readonly amount: string;
  /** Fractional digits of `exact`. */
  readonly exactDecimals: number;
}

/**
 * Value of `balanceRaw` units of a mosaic with `divisibility` at `price` per whole unit:
 * exact = balanceRaw x price.scaled / 10^(divisibility + price.decimals), and the same rounded to
 * `decimals` places. multiplyAndRound(9111457601413n, 6, parse("12.34"), 0) ->
 * { exact: "112435386.80143642", amount: "112435387" }.
 */
export function multiplyAndRound(
  balanceRaw: bigint,
  divisibility: number,
  price: DecimalPrice,
  decimals: number,
): HoldingsValue {
  if (balanceRaw < 0n) throw new RangeError('balanceRaw must be non-negative');
  if (!Number.isInteger(divisibility) || divisibility < 0)
    throw new RangeError('divisibility >= 0');
  const exactDecimals = divisibility + price.decimals;
  const raw = balanceRaw * price.scaled;
  return {
    exact: formatScaled(raw, exactDecimals),
    amount: formatScaled(roundScaled(raw, exactDecimals, decimals), decimals),
    exactDecimals,
  };
}
