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
 * identified by sorting. So a node operator that is its own node's beneficiary gets two receipts
 * for each block it harvests and one (the beneficiary share) for each block a delegator harvests:
 * beneficiary receipts are not a count of delegators' blocks, which is why the totals also count
 * blocks (blocksHarvested, blocksBeneficiaryOnly), each block once.
 *
 * Statements are read in height chunks of about CHUNK_DAYS: catapult-rest answers the first page
 * of a wide height range plus targetAddress too slowly (a year timed out on mainnet, 2026-09-19,
 * while half a year answered), so the tool splits the range and halves a chunk that times out.
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
  /** Blocks in which the account received at least one receipt. */
  blocks: number;
  /** Blocks the account harvested: it received the harvester share (one receipt per block). */
  blocksHarvested: number;
  /**
   * Blocks another account harvested in which the account received only the beneficiary share
   * (typically delegators of the node that names it as beneficiary). A block the account harvested
   * counts in blocksHarvested even when it also paid the account the beneficiary share. Blocks
   * whose receipts were not recognised count in blocksUnrecognised.
   */
  blocksBeneficiaryOnly: number;
  /**
   * Blocks whose share split was not recognised (all their receipts are unknown). Every block
   * counts in exactly one of blocksHarvested, blocksBeneficiaryOnly and blocksUnrecognised. Not
   * an output field: the summary names them.
   */
  blocksUnrecognised: number;
  /**
   * Beneficiary receipts from blocks the account harvested itself, which it gets as its own
   * node's beneficiary. Not an output field: the summary says how many of the beneficiary
   * receipts these are.
   */
  beneficiaryReceiptsInOwnBlocks: number;
}

export interface DailyBucket extends HarvestTotals {
  readonly date: string;
}

export interface MonthlyBucket extends HarvestTotals {
  /** Calendar month (YYYY-MM) in SYMBOL_TIMEZONE or UTC. */
  readonly month: string;
}

export interface HarvestAggregate {
  /** Every matching receipt, by height then harvester before beneficiary. */
  readonly rows: HarvestRow[];
  readonly totals: HarvestTotals;
  /** Calendar-day buckets (SYMBOL_TIMEZONE or UTC), ascending; only days with receipts. */
  readonly daily: DailyBucket[];
  /**
   * Calendar-month buckets, ascending; only months with receipts. Keyed by the first seven
   * characters of the same day key as `daily`, so a month is exactly the sum of its days.
   */
  readonly monthly: MonthlyBucket[];
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
    blocks: 0,
    blocksHarvested: 0,
    blocksBeneficiaryOnly: 0,
    blocksUnrecognised: 0,
    beneficiaryReceiptsInOwnBlocks: 0,
  };
}

/** The receipts of ONE block, all at one height; never empty. */
type Block = readonly [HarvestRow, ...HarvestRow[]];

/** A block and the calendar day (SYMBOL_TIMEZONE or UTC) it falls on. */
interface DatedBlock {
  readonly rows: Block;
  readonly day: string;
}

/** Adds the receipts of one block and counts the block once, by the role the account had in it. */
function addBlock(totals: HarvestTotals, block: Block): void {
  for (const row of block) {
    totals.receipts += 1;
    totals.raw += row.raw;
    totals[row.kind].receipts += 1;
    totals[row.kind].raw += row.raw;
  }
  totals.blocks += 1;
  if (block.some((row) => row.kind === 'harvester')) {
    totals.blocksHarvested += 1;
    totals.beneficiaryReceiptsInOwnBlocks += block.filter(
      (row) => row.kind === 'beneficiary',
    ).length;
  } else if (block.some((row) => row.kind === 'beneficiary')) {
    totals.blocksBeneficiaryOnly += 1;
  } else {
    totals.blocksUnrecognised += 1;
  }
}

/** Rows sorted by height, grouped into one block per height. */
function groupByHeight(rows: readonly HarvestRow[]): Block[] {
  const blocks: [HarvestRow, ...HarvestRow[]][] = [];
  for (const row of rows) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last[0].height === row.height) last.push(row);
    else blocks.push([row]);
  }
  return blocks;
}

const KIND_ORDER: Record<HarvestKind, number> = { harvester: 0, beneficiary: 1, unknown: 2 };

/**
 * Sums the blocks into buckets keyed by `keyOf`, returned in ascending key order. A block's
 * receipts share its timestamp, so a block always falls into exactly one bucket.
 */
function bucketBy<B extends HarvestTotals>(
  blocks: readonly DatedBlock[],
  keyOf: (block: DatedBlock) => string,
  create: (key: string) => B,
): B[] {
  const buckets = new Map<string, B>();
  for (const block of blocks) {
    const key = keyOf(block);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = create(key);
      buckets.set(key, bucket);
    }
    addBlock(bucket, block.rows);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, b]) => b);
}

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

  // Every row of a block carries the block's timestamp, so the first one dates the block.
  const blocks: DatedBlock[] = groupByHeight(rows).map((block) => ({
    rows: block,
    day: calendarDateKey(block[0].time, options.timeZone),
  }));
  const totals = emptyTotals();
  for (const block of blocks) addBlock(totals, block.rows);
  const daily = bucketBy(
    blocks,
    (block) => block.day,
    (date) => ({ date, ...emptyTotals() }),
  );
  const monthly = bucketBy(
    blocks,
    (block) => block.day.slice(0, 7),
    (month) => ({ month, ...emptyTotals() }),
  );
  return { rows, totals, daily, monthly, unknownStatements };
}

/** Policy constant, not a network constant: one statement query covers about this many days. */
export const CHUNK_DAYS = 90;
/** Policy constant: a chunk that timed out is never shrunk below about this many days. */
export const MIN_CHUNK_DAYS = 7;

const DAY_MS = 86_400_000;

/** Inclusive height range. */
export interface HeightRange {
  readonly fromHeight: number;
  readonly toHeight: number;
}

/** Blocks produced in `days` at the target block time from /network/properties; at least 1. */
export function blocksForDays(days: number, blockGenerationTargetTimeMs: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('days must be positive');
  }
  if (!Number.isFinite(blockGenerationTargetTimeMs) || blockGenerationTargetTimeMs <= 0) {
    throw new Error('blockGenerationTargetTimeMs must be positive');
  }
  return Math.max(1, Math.round((days * DAY_MS) / blockGenerationTargetTimeMs));
}

/**
 * Consecutive inclusive ranges of at most `chunkBlocks` heights covering [fromHeight, toHeight]:
 * ascending, no overlap, no gap. The last range holds the remainder.
 */
export function splitHeightRange(
  fromHeight: number,
  toHeight: number,
  chunkBlocks: number,
): HeightRange[] {
  if (!Number.isSafeInteger(fromHeight) || !Number.isSafeInteger(toHeight)) {
    throw new RangeError('heights must be integers');
  }
  if (fromHeight > toHeight) {
    throw new RangeError('fromHeight must not be above toHeight');
  }
  if (!Number.isSafeInteger(chunkBlocks) || chunkBlocks < 1) {
    throw new RangeError('chunkBlocks must be a positive integer');
  }
  const ranges: HeightRange[] = [];
  for (let start = fromHeight; start <= toHeight; start += chunkBlocks) {
    ranges.push({ fromHeight: start, toHeight: Math.min(start + chunkBlocks - 1, toHeight) });
  }
  return ranges;
}

/**
 * Chunk length to retry with after a range of `lengthBlocks` timed out: half of it (rounded up),
 * but never below `minChunkBlocks`. Null when the range is already at or below the minimum, so a
 * failure is only final for a range of at most `minChunkBlocks`.
 */
export function shrinkChunkBlocks(lengthBlocks: number, minChunkBlocks: number): number | null {
  if (!Number.isSafeInteger(lengthBlocks) || lengthBlocks < 1) {
    throw new RangeError('lengthBlocks must be a positive integer');
  }
  if (!Number.isSafeInteger(minChunkBlocks) || minChunkBlocks < 1) {
    throw new RangeError('minChunkBlocks must be a positive integer');
  }
  if (lengthBlocks <= minChunkBlocks) return null;
  return Math.max(Math.ceil(lengthBlocks / 2), minChunkBlocks);
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
