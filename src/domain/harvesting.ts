/**
 * Harvest income: classification of HarvestFee receipts, deterministic BigInt aggregation, and the
 * date-to-height search used by symbol_harvesting_income. Pure: no REST client, the block
 * timestamp lookup is injected.
 *
 * Each harvested block emits one transaction statement (source 0/0) with one HarvestFee (8515)
 * receipt per share of the block reward: harvester, beneficiary and network sink, split by
 * `harvestBeneficiaryPercentage` (B) and `harvestNetworkPercentage` (N) from /network/properties,
 * i.e. (100-B-N):B:N. The three receipts are separate even when the harvester is its own
 * beneficiary (verified on mainnet, 2026-09-11). Older blocks or accounts without a beneficiary
 * show two receipts, (100-N):N. Receipts are not returned in amount order, so the shares are
 * identified by sorting.
 */
import type { Receipt, TransactionStatementInfo } from '../client/schemas.js';
import { calendarDateKey } from './localdate.js';

export type HarvestKind = 'harvester' | 'beneficiary' | 'unknown';

export interface HarvestShares {
  readonly beneficiaryPercentage: number;
  readonly networkPercentage: number;
}

export interface ClassifiedReceipt {
  readonly receipt: Receipt;
  readonly amount: bigint;
  readonly kind: HarvestKind;
}

type Role = 'harvester' | 'beneficiary' | 'network';

/** Share patterns a statement may show, largest share first. */
function candidatePatterns(shares: HarvestShares): ReadonlyArray<ReadonlyArray<[Role, number]>> {
  const b = shares.beneficiaryPercentage;
  const n = shares.networkPercentage;
  const split: Array<[Role, number]> = [
    ['harvester', 100 - b - n],
    ['beneficiary', b],
    ['network', n],
  ];
  const merged: Array<[Role, number]> = [
    ['harvester', 100 - n],
    ['network', n],
  ];
  return [split, merged].map((p) => p.filter(([, pct]) => pct > 0).sort((x, y) => y[1] - x[1]));
}

/**
 * Assigns harvester / beneficiary / unknown to the HarvestFee receipts of ONE statement.
 * Receipts are sorted by amount (descending) and matched against the share pattern with the same
 * number of receipts; every amount must be within 1 percentage point of the statement total
 * (integer arithmetic: |amount*100 - total*pct| <= total). Any mismatch marks the whole statement
 * unknown. The network sink's receipt is reported as unknown too, but callers only keep receipts
 * addressed to the account being analysed, so it never reaches the totals unless that account is
 * the sink.
 */
export function classifyHarvestReceipts(
  receipts: readonly Receipt[],
  shares: HarvestShares,
): ClassifiedReceipt[] {
  const sorted = receipts
    .map((receipt) => ({ receipt, amount: BigInt(receipt.amount ?? '0') }))
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  const total = sorted.reduce((acc, r) => acc + r.amount, 0n);
  const pattern = candidatePatterns(shares).find((p) => p.length === sorted.length);
  const matches =
    pattern !== undefined &&
    total > 0n &&
    sorted.every((r, i) => {
      const pct = BigInt(pattern[i]?.[1] ?? 0);
      const diff = r.amount * 100n - total * pct;
      return (diff < 0n ? -diff : diff) <= total;
    });
  return sorted.map((r, i) => {
    const role = matches ? pattern?.[i]?.[0] : undefined;
    const kind: HarvestKind =
      role === 'harvester' ? 'harvester' : role === 'beneficiary' ? 'beneficiary' : 'unknown';
    return { ...r, kind };
  });
}

export interface HarvestRow {
  readonly height: number;
  /** Wall-clock time of the block (epochAdjustment applied). */
  readonly time: Date;
  readonly kind: HarvestKind;
  readonly raw: bigint;
}

export interface KindTotals {
  receipts: number;
  raw: bigint;
}

export interface HarvestTotals {
  receipts: number;
  raw: bigint;
  harvester: KindTotals;
  beneficiary: KindTotals;
  unknown: KindTotals;
}

export interface DailyBucket extends HarvestTotals {
  readonly date: string;
}

export interface HarvestAggregate {
  /** Every matching receipt, by height then harvester before beneficiary. */
  readonly rows: HarvestRow[];
  readonly totals: HarvestTotals;
  /** Calendar-day buckets (SYMBOL_TIMEZONE or UTC), ascending; only days with receipts. */
  readonly daily: DailyBucket[];
  /** Statements whose share pattern could not be recognised (their receipts are still counted). */
  readonly unknownStatements: number;
}

export interface AggregateOptions {
  /** 48-hex address of the account being analysed. */
  readonly targetAddressHex: string;
  readonly currencyMosaicId: string;
  readonly harvestFeeType: number;
  readonly shares: HarvestShares;
  readonly epochAdjustmentSeconds: number;
  readonly timeZone?: string | undefined;
}

function emptyTotals(): HarvestTotals {
  return {
    receipts: 0,
    raw: 0n,
    harvester: { receipts: 0, raw: 0n },
    beneficiary: { receipts: 0, raw: 0n },
    unknown: { receipts: 0, raw: 0n },
  };
}

function add(totals: HarvestTotals, row: HarvestRow): void {
  totals.receipts += 1;
  totals.raw += row.raw;
  totals[row.kind].receipts += 1;
  totals[row.kind].raw += row.raw;
}

const KIND_ORDER: Record<HarvestKind, number> = { harvester: 0, beneficiary: 1, unknown: 2 };

/**
 * Sums the HarvestFee receipts of the currency mosaic addressed to `targetAddressHex` across the
 * given statements. All arithmetic is BigInt; nothing is rounded.
 */
export function aggregateHarvestIncome(
  statements: readonly TransactionStatementInfo[],
  options: AggregateOptions,
): HarvestAggregate {
  const target = options.targetAddressHex.toUpperCase();
  const currency = options.currencyMosaicId.toUpperCase();
  const rows: HarvestRow[] = [];
  let unknownStatements = 0;

  for (const info of statements) {
    const harvestReceipts = info.statement.receipts.filter(
      (r) =>
        r.type === options.harvestFeeType &&
        r.mosaicId?.toUpperCase() === currency &&
        r.amount !== undefined &&
        r.targetAddress !== undefined,
    );
    if (harvestReceipts.length === 0) continue;
    const classified = classifyHarvestReceipts(harvestReceipts, options.shares);
    const mine = classified.filter((c) => c.receipt.targetAddress?.toUpperCase() === target);
    if (mine.length === 0) continue;
    if (mine.some((c) => c.kind === 'unknown')) unknownStatements += 1;
    const height = Number(info.statement.height);
    const time = new Date(options.epochAdjustmentSeconds * 1000 + Number(info.meta.timestamp));
    for (const c of mine) rows.push({ height, time, kind: c.kind, raw: c.amount });
  }

  rows.sort((a, b) => a.height - b.height || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const totals = emptyTotals();
  const buckets = new Map<string, DailyBucket>();
  for (const row of rows) {
    add(totals, row);
    const date = calendarDateKey(row.time, options.timeZone);
    let bucket = buckets.get(date);
    if (!bucket) {
      bucket = { date, ...emptyTotals() };
      buckets.set(date, bucket);
    }
    add(bucket, row);
  }
  const daily = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { rows, totals, daily, unknownStatements };
}

/** Network timestamp (ms) of a block; injected so the search is testable without HTTP. */
export type BlockTimestampLookup = (height: number) => Promise<number>;

function memoize(lookup: BlockTimestampLookup): BlockTimestampLookup {
  const cache = new Map<number, Promise<number>>();
  return (height) => {
    let p = cache.get(height);
    if (!p) {
      p = lookup(height);
      cache.set(height, p);
    }
    return p;
  };
}

/**
 * Smallest height in [lo, hi] whose block timestamp is >= targetMs, or null when even block `hi`
 * is earlier. Binary search over the monotonic block timestamps: about log2(hi - lo) lookups.
 */
export async function firstHeightAtOrAfter(
  targetMs: number,
  lo: number,
  hi: number,
  lookup: BlockTimestampLookup,
): Promise<number | null> {
  const ts = memoize(lookup);
  if (lo > hi) return null;
  if ((await ts(hi)) < targetMs) return null;
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await ts(mid)) >= targetMs) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Largest height in [lo, hi] whose block timestamp is <= targetMs, or null when block `lo` is later. */
export async function lastHeightAtOrBefore(
  targetMs: number,
  lo: number,
  hi: number,
  lookup: BlockTimestampLookup,
): Promise<number | null> {
  const ts = memoize(lookup);
  if (lo > hi) return null;
  if ((await ts(lo)) > targetMs) return null;
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((await ts(mid)) <= targetMs) low = mid;
    else high = mid - 1;
  }
  return low;
}
