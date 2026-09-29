/**
 * Node health thresholds: the pure rules behind symbol_node_health (and the sync judgment of
 * symbol_node_status). Every threshold is derived from values read from /network/properties
 * (blockGenerationTargetTime, votingSetGrouping, epochAdjustment); nothing network-specific is
 * hard-coded here.
 */
import type { CheckStatus } from './delegation.js';
import { quoteUntrusted } from './quote.js';
import type { UntrustedText } from './sanitize.js';
import { networkTimestampToDate, roundTo } from './time.js';

/**
 * Longest `/node/health` service status kept. NodeStatusEnum is `up | down`; the node can send any
 * string, so a status is untrusted text like a friendly name.
 */
export const MAX_SERVICE_STATUS_LENGTH = 32;

/** Shown for a status that is empty, or nothing but removed characters. */
export const EMPTY_SERVICE_STATUS = '(empty)';

/**
 * A `/node/health` status (`status.apiNode`, `status.db`) cleaned for judging and for output alike.
 * Judging the cleaned value keeps the verdict and the text shown next to it consistent; a node that
 * hides characters in a status gains nothing it could not get by sending "up" outright.
 */
export function serviceStatus(value: string, text: UntrustedText): string {
  return text.clean(value, MAX_SERVICE_STATUS_LENGTH) || EMPTY_SERVICE_STATUS;
}

/**
 * A cleaned service status for a summary line: `up`, `down` (NodeStatusEnum) and the placeholder
 * for an empty status stay as they are; any other text the node sent is quoted, so it cannot pose
 * as the server's words (domain/quote.ts).
 */
export function serviceStatusText(status: string): string {
  return isDocumentedStatus(status) ? status : quoteUntrusted(status);
}

/**
 * A summary sentence about one service (`API node`, `Database`): `… service is down.` for a
 * documented status, `… service reports status "…".` for any other text the node sent.
 */
export function serviceStatusSentence(service: string, status: string): string {
  return isDocumentedStatus(status)
    ? `${service} service is ${status}.`
    : `${service} service reports status ${quoteUntrusted(status)}.`;
}

function isDocumentedStatus(status: string): boolean {
  return status === 'up' || status === 'down' || status === EMPTY_SERVICE_STATUS;
}

/** Wall-clock window whose worth of blocks the node database may lag the chain height. */
export const STORAGE_TOLERANCE_WINDOW_MS = 60_000;

function assertBlockTime(blockGenerationTargetTimeMs: number): void {
  if (!Number.isFinite(blockGenerationTargetTimeMs) || blockGenerationTargetTimeMs <= 0) {
    throw new Error('blockGenerationTargetTimeMs must be positive');
  }
}

/** Blocks produced in one minute at the target block time, at least 1 (30 s -> 2, 15 s -> 4). */
export function storageToleranceBlocks(blockGenerationTargetTimeMs: number): number {
  assertBlockTime(blockGenerationTargetTimeMs);
  return Math.max(1, Math.ceil(STORAGE_TOLERANCE_WINDOW_MS / blockGenerationTargetTimeMs));
}

export interface StorageAssessment {
  readonly deltaBlocks: number;
  readonly toleranceBlocks: number;
  readonly status: 'ok' | 'warn';
}

/** |numBlocks - height| within the tolerance is ok; more suggests the database and chain disagree. */
export function assessStorage(
  numBlocks: number,
  height: number,
  blockGenerationTargetTimeMs: number,
): StorageAssessment {
  const toleranceBlocks = storageToleranceBlocks(blockGenerationTargetTimeMs);
  const deltaBlocks = Math.abs(numBlocks - height);
  return { deltaBlocks, toleranceBlocks, status: deltaBlocks <= toleranceBlocks ? 'ok' : 'warn' };
}

/** The node's send timestamp is the moment closest to "now"; receive is the fallback. */
export function pickNodeTimestamp(ts: {
  readonly sendTimestamp?: string | undefined;
  readonly receiveTimestamp?: string | undefined;
}): string | null {
  return ts.sendTimestamp ?? ts.receiveTimestamp ?? null;
}

/** Node clock minus local clock in milliseconds; positive when the node is ahead. */
export function computeClockSkewMs(
  nodeTimestampMs: string | number,
  epochAdjustmentSeconds: number,
  localNow: Date,
): number {
  return (
    networkTimestampToDate(nodeTimestampMs, epochAdjustmentSeconds).getTime() - localNow.getTime()
  );
}

export interface SkewThresholds {
  readonly warnMs: number;
  readonly failMs: number;
}

/** Half a block time is tolerable; a whole block time of drift can make harvesting fail. */
export function skewThresholds(blockGenerationTargetTimeMs: number): SkewThresholds {
  assertBlockTime(blockGenerationTargetTimeMs);
  return { warnMs: blockGenerationTargetTimeMs / 2, failMs: blockGenerationTargetTimeMs };
}

export function assessClockSkew(
  skewMs: number,
  blockGenerationTargetTimeMs: number,
): 'ok' | 'warn' | 'fail' {
  const { warnMs, failMs } = skewThresholds(blockGenerationTargetTimeMs);
  const magnitude = Math.abs(skewMs);
  if (magnitude < warnMs) return 'ok';
  if (magnitude < failMs) return 'warn';
  return 'fail';
}

export interface FinalizationLag {
  readonly lagBlocks: number;
  readonly lagMinutes: number;
  readonly warnBlocks: number;
  readonly failBlocks: number;
  readonly status: 'ok' | 'warn' | 'fail';
}

/**
 * Blocks between the chain height and the last finalized height. Less than half an epoch
 * (votingSetGrouping / 2 blocks) is normal; a whole epoch or more means finalization has stalled.
 */
export function assessFinalizationLag(
  height: number,
  finalizedHeight: number,
  votingSetGrouping: number,
  blockGenerationTargetTimeMs: number,
): FinalizationLag {
  assertBlockTime(blockGenerationTargetTimeMs);
  if (!Number.isInteger(votingSetGrouping) || votingSetGrouping <= 0) {
    throw new Error('votingSetGrouping must be a positive integer');
  }
  const lagBlocks = Math.max(0, height - finalizedHeight);
  const warnBlocks = votingSetGrouping / 2;
  const failBlocks = votingSetGrouping;
  const status = lagBlocks < warnBlocks ? 'ok' : lagBlocks < failBlocks ? 'warn' : 'fail';
  return {
    lagBlocks,
    lagMinutes: roundTo((lagBlocks * blockGenerationTargetTimeMs) / 60_000, 1),
    warnBlocks,
    failBlocks,
    status,
  };
}

/**
 * How many target block times old the latest block may be. Beyond WARN the node is not synced
 * (symbol_node_status) and chain_tip_age warns (symbol_node_health); beyond FAIL that check fails.
 * Policy multiples of blockGenerationTargetTime, not network constants (mainnet 30 s: 300 s, 900 s).
 */
export const CHAIN_TIP_WARN_BLOCK_TIMES = 10;
export const CHAIN_TIP_FAIL_BLOCK_TIMES = 30;

export interface ChainTipThresholds {
  readonly warnSeconds: number;
  readonly failSeconds: number;
}

export function chainTipThresholds(blockGenerationTargetTimeMs: number): ChainTipThresholds {
  assertBlockTime(blockGenerationTargetTimeMs);
  return {
    warnSeconds: (CHAIN_TIP_WARN_BLOCK_TIMES * blockGenerationTargetTimeMs) / 1000,
    failSeconds: (CHAIN_TIP_FAIL_BLOCK_TIMES * blockGenerationTargetTimeMs) / 1000,
  };
}

export interface ChainTipAge {
  /** Wall-clock time of the latest block. */
  readonly latestBlockDate: Date;
  /** now minus the latest block time in whole seconds; negative when the block is ahead of now. */
  readonly ageSeconds: number;
  readonly status: 'ok' | 'warn' | 'fail';
}

/**
 * Age of the latest block (the chain tip) against the local clock `now`: up to `warnSeconds` is
 * ok, beyond it warn (the node is behind or stalled), beyond `failSeconds` fail. The age is
 * rounded to whole seconds before it is judged, as symbol_node_status has always reported it.
 * Throws for a timestamp that gives no valid time (the node may send any uint64: one too long for
 * a number fails in networkTimestampToDate, one beyond the range of Date here), rather than judging
 * NaN seconds as a failure.
 */
export function assessChainTipAge(
  latestBlockTimestamp: string | number,
  epochAdjustmentSeconds: number,
  now: Date,
  thresholds: ChainTipThresholds,
): ChainTipAge {
  const latestBlockDate = networkTimestampToDate(latestBlockTimestamp, epochAdjustmentSeconds);
  if (Number.isNaN(latestBlockDate.getTime())) {
    throw new Error(`block timestamp ${latestBlockTimestamp} is not a valid time`);
  }
  // `+ 0` turns the -0 that Math.round gives for a block a fraction of a second ahead into 0.
  const ageSeconds = Math.round((now.getTime() - latestBlockDate.getTime()) / 1000) + 0;
  const status =
    ageSeconds <= thresholds.warnSeconds
      ? 'ok'
      : ageSeconds <= thresholds.failSeconds
        ? 'warn'
        : 'fail';
  return { latestBlockDate, ageSeconds, status };
}

export type HealthVerdict = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Any fail -> unhealthy. Otherwise any warn OR unknown -> degraded: a check that could not be
 * made is not evidence of health. All ok -> healthy.
 */
export function deriveHealthVerdict(
  checks: ReadonlyArray<{ readonly status: CheckStatus }>,
): HealthVerdict {
  if (checks.some((c) => c.status === 'fail')) return 'unhealthy';
  if (checks.some((c) => c.status === 'warn' || c.status === 'unknown')) return 'degraded';
  return 'healthy';
}
