/**
 * Exact amount formatting. Symbol amounts are unsigned 64-bit integers serialised as
 * decimal strings; XYM has divisibility 6 (1_000_000 raw = 1 XYM).
 */

export function toBigInt(raw: string | number | bigint): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) throw new Error('amount must be a safe integer');
    return BigInt(raw);
  }
  if (!/^\d+$/.test(raw)) throw new Error(`amount must be a decimal integer string, got ${raw}`);
  return BigInt(raw);
}

/**
 * Formats a raw integer amount with the given divisibility as a fixed-point decimal string.
 * formatAmount('4321000000000', 6) -> '4321000.000000'; formatAmount('1000', 0) -> '1000'.
 */
export function formatAmount(raw: string | number | bigint, divisibility: number): string {
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 18) {
    throw new Error('divisibility must be an integer between 0 and 18');
  }
  const value = toBigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (divisibility === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const base = 10n ** BigInt(divisibility);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(divisibility, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

/** Ratio helper used for "margin" style outputs; returns a signed formatted amount. */
export function formatSignedAmount(raw: bigint, divisibility: number): string {
  return formatAmount(raw, divisibility);
}
