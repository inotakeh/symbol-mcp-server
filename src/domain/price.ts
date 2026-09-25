/**
 * Pure arithmetic for symbol_holdings_value: a caller-supplied unit price as a decimal string,
 * a currency code, and balance x price in BigInt. No floating point anywhere: the price is kept
 * as an integer plus a number of decimal places, so `raw balance x scaled price` is exact and the
 * only rounding is the final half-up rounding of `value.amount`.
 *
 * How many decimals that rounding keeps (roundingRule): the caller's `decimals` when given; else
 * the minor-unit digits Intl knows for the currency (Unicode CLDR as bundled with the running
 * Node.js: JPY 0, USD 2, KWD 3, CLF 4); else, for a code Intl does not know (BTC, USDT), none.
 * No ISO 4217 table is kept here. A non-zero product that would round to 0 is not rounded either
 * (multiplyAndRound), so a small holding never shows as 0.
 *
 * The server never fetches or validates a price (DESIGN-BRIEF §2-7: no traffic beyond
 * SYMBOL_NODE_URL and SYMBOL_REFERENCE_NODES); everything here is arithmetic on values the caller
 * passed in.
 */

/** Longest fractional part accepted for a unit price (policy constant). */
export const MAX_PRICE_DECIMALS = 12;

/** Longest unit price string accepted, before any normalisation (policy constant). */
export const MAX_PRICE_LENGTH = 40;

/** Most decimals a caller may ask value.amount to be rounded to (the same bound as the price). */
export const MAX_ROUNDING_DECIMALS = 12;

/**
 * Which rule set the decimals of value.amount: `caller` (the decimals argument), `currency` (the
 * digits Intl gives the currency), `none` (Intl does not know the code, so no rounding), or
 * `rounds_to_zero` (rounding would have shown a non-zero value as 0, so no rounding).
 */
export const DECIMALS_SOURCES = ['caller', 'currency', 'none', 'rounds_to_zero'] as const;
export type DecimalsSource = (typeof DECIMALS_SOURCES)[number];

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

/** Validates the caller's `decimals`: an integer from 0 to MAX_ROUNDING_DECIMALS. */
export function parseRoundingDecimals(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_ROUNDING_DECIMALS) {
    throw new PriceParseError(
      `decimals ${value} is not an integer from 0 to ${MAX_ROUNDING_DECIMALS}. Pass how many decimals to round the value to, or omit decimals to use the digits Intl (Unicode CLDR) gives the currency.`,
    );
  }
  return value;
}

/**
 * Digits of the codes Intl knows, looked up once per process (the Intl data does not change).
 * Unknown codes are not kept, so the map stays within the CLDR currency list whatever codes
 * callers pass.
 */
const knownDigits = new Map<string, number>();

/**
 * Minor-unit digits of `currency` as Intl knows them (Unicode CLDR as bundled with the running
 * Node.js; for a few codes CLDR differs from ISO 4217, e.g. HUF 0), or null for a code Intl does
 * not know (BTC, USDT, XYM). CLDR data, not a table of ours.
 */
export function intlCurrencyDigits(currency: string): number | null {
  const cached = knownDigits.get(currency);
  if (cached !== undefined) return cached;
  const digits = lookUpIntlDigits(currency);
  if (digits !== null) knownDigits.set(currency, digits);
  return digits;
}

function lookUpIntlDigits(currency: string): number | null {
  try {
    // With fallback 'none' a code Intl does not know has no name. Built here, not at module load,
    // so a Node.js without Intl loses only this lookup, not the whole server.
    const names = new Intl.DisplayNames(['en'], { type: 'currency', fallback: 'none' });
    if (names.of(currency) === undefined) return null;
    const { maximumFractionDigits } = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions();
    return typeof maximumFractionDigits === 'number' ? maximumFractionDigits : null;
  } catch {
    // Not a well-formed three-letter code (USDT has four letters), or no Intl: no digits known.
    return null;
  }
}

/** Where the decimals of a rounding rule come from, before the zero check. */
export type RuleSource = Exclude<DecimalsSource, 'rounds_to_zero'>;

export interface RoundingRule {
  /** Decimals to round value.amount to; null for no rounding. */
  readonly decimals: number | null;
  readonly source: RuleSource;
}

/** The decimals of value.amount: the caller's, else the digits Intl gives the currency, else none. */
export function roundingRule(currency: string, callerDecimals?: number): RoundingRule {
  if (callerDecimals !== undefined) return { decimals: callerDecimals, source: 'caller' };
  const digits = intlCurrencyDigits(currency);
  return digits === null
    ? { decimals: null, source: 'none' }
    : { decimals: digits, source: 'currency' };
}

/** A fixed-point string without trailing fractional zeros: "0.0003000" -> "0.0003", "21.0" -> "21". */
export function trimFraction(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
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
  /** Fractional digits of `exact`. */
  readonly exactDecimals: number;
  /**
   * The same value rounded half up to `roundingDecimals`; when it is not rounded
   * (`roundingDecimals` null), `exact` without trailing zeros.
   */
  readonly amount: string;
  /** Decimals `amount` was rounded to; null when it was not rounded. */
  readonly roundingDecimals: number | null;
  /** The rule's source, or `rounds_to_zero` when the rule was not applied to keep a value non-zero. */
  readonly decimalsSource: DecimalsSource;
}

/**
 * Value of `balanceRaw` units of a mosaic with `divisibility` at `price` per whole unit:
 * exact = balanceRaw x price.scaled / 10^(divisibility + price.decimals), and the same rounded as
 * `rule` says. multiplyAndRound(9111457601413n, 6, parse("12.34"), { decimals: 0, ... }) ->
 * { exact: "112435386.80143642", amount: "112435387", ... }. A rule without decimals keeps every
 * digit, and so does a non-zero value that would round to 0 (a small holding never shows as 0).
 */
export function multiplyAndRound(
  balanceRaw: bigint,
  divisibility: number,
  price: DecimalPrice,
  rule: RoundingRule,
): HoldingsValue {
  if (balanceRaw < 0n) throw new RangeError('balanceRaw must be non-negative');
  if (!Number.isInteger(divisibility) || divisibility < 0)
    throw new RangeError('divisibility >= 0');
  const exactDecimals = divisibility + price.decimals;
  const raw = balanceRaw * price.scaled;
  const exact = formatScaled(raw, exactDecimals);
  const unrounded = (decimalsSource: DecimalsSource): HoldingsValue => ({
    exact,
    exactDecimals,
    amount: trimFraction(exact),
    roundingDecimals: null,
    decimalsSource,
  });
  if (rule.decimals === null) return unrounded(rule.source);
  const rounded = roundScaled(raw, exactDecimals, rule.decimals);
  if (raw > 0n && rounded === 0n) return unrounded('rounds_to_zero');
  return {
    exact,
    exactDecimals,
    amount: formatScaled(rounded, rule.decimals),
    roundingDecimals: rule.decimals,
    decimalsSource: rule.source,
  };
}
