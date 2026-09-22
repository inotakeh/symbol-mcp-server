/**
 * Pure arithmetic for symbol_account_rank: mosaic balances out of an account DTO, the rank of a
 * row in a paged holder list, and a share of supply computed with BigInt (no floating point).
 */

/**
 * Largest page catapult-rest serves for `GET /accounts` (symbol-openapi pageSizeQuery maximum 100).
 * A policy constant: the tool always scans 100 holders per request.
 */
export const HOLDER_PAGE_SIZE = 100;

export interface MosaicEntry {
  readonly id: string;
  readonly amount: string;
}

/** Balance of one mosaic in an account's mosaic list; 0n when the account holds none of it. */
export function mosaicBalanceOf(mosaics: readonly MosaicEntry[], mosaicId: string): bigint {
  const wanted = mosaicId.toUpperCase();
  const entry = mosaics.find((m) => m.id.toUpperCase() === wanted);
  return entry ? BigInt(entry.amount) : 0n;
}

/** Rank (1-based) of the row at `index` (0-based) on page `pageNumber` (1-based). */
export function rankOf(pageNumber: number, pageSize: number, index: number): number {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new RangeError('pageNumber >= 1');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize >= 1');
  if (!Number.isInteger(index) || index < 0) throw new RangeError('index >= 0');
  return (pageNumber - 1) * pageSize + index + 1;
}

/** Number of pages that cover ranks 1..maxRank. */
export function pagesToScan(maxRank: number, pageSize: number): number {
  if (!Number.isInteger(maxRank) || maxRank < 1) throw new RangeError('maxRank >= 1');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize >= 1');
  return Math.ceil(maxRank / pageSize);
}

/**
 * `part / total` as a percentage string with `decimals` fractional digits, rounded half up in
 * integer arithmetic: percentOfSupply(1n, 3n) -> '33.3333'. Null when `total` is 0.
 */
export function percentOfSupply(part: bigint, total: bigint, decimals = 4): string | null {
  if (part < 0n || total < 0n) throw new RangeError('amounts must be non-negative');
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError('decimals >= 0');
  if (total === 0n) return null;
  const scale = 10n ** BigInt(decimals);
  const scaled = (part * 100n * scale + total / 2n) / total;
  if (decimals === 0) return scaled.toString();
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(decimals, '0');
  return `${whole.toString()}.${frac}`;
}
