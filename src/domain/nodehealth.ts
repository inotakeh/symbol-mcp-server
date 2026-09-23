/**
 * Node health thresholds: the pure rules behind symbol_node_health. Every threshold is derived
 * from values read from /network/properties (blockGenerationTargetTime, votingSetGrouping,
 * epochAdjustment); nothing network-specific is hard-coded here.
 */
import type { CheckStatus } from './delegation.js';
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
