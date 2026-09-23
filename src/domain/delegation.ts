/**
 * Delegated-harvesting diagnosis: the pure rules behind symbol_delegation_diagnose. No REST
 * access here; the tool gathers the facts and these functions turn them into checks and a verdict.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface DiagnoseCheck {
  readonly id: string;
  readonly status: CheckStatus;
  /** What was observed. */
  readonly detail: string;
  /** What to do about it; null when nothing is needed. */
  readonly hint: string | null;
}

export type Verdict = 'active' | 'not_active' | 'cannot_verify';

/**
 * Any fail -> not_active. No fail but at least one unknown -> cannot_verify (a step could not be
 * checked from the configured node). Otherwise active, even when some checks only warn.
 */
export function deriveVerdict(checks: ReadonlyArray<{ readonly status: CheckStatus }>): Verdict {
  if (checks.some((c) => c.status === 'fail')) return 'not_active';
  if (checks.some((c) => c.status === 'unknown')) return 'cannot_verify';
  return 'active';
}

export type HarvesterBalance = 'below' | 'within' | 'above';

/**
 * Where a balance of the harvesting mosaic stands against the harvesting limits, the one rule that
 * symbol_harvesting_status and symbol_delegation_diagnose share. Both bounds are inclusive:
 * catapult's ImportanceView::canHarvest (client/catapult/src/catapult/cache_core/ImportanceView.cpp)
 * needs minHarvesterBalance <= balance <= maxHarvesterBalance, and an account outside that range
 * cannot harvest at all; nothing is capped. Importance is only assigned from minHarvesterBalance
 * up (HighValueAccounts.cpp: balance >= MinHarvesterBalance).
 */
export function classifyHarvesterBalance(
  balance: bigint,
  minHarvesterBalance: bigint,
  maxHarvesterBalance: bigint,
): HarvesterBalance {
  if (balance < minHarvesterBalance) return 'below';
  if (balance > maxHarvesterBalance) return 'above';
  return 'within';
}

/** Height of the next importance recalculation: the next multiple of `importanceGrouping`. */
export function nextImportanceRecalculationHeight(
  currentHeight: number,
  importanceGrouping: number,
): number {
  if (!Number.isInteger(importanceGrouping) || importanceGrouping <= 0) {
    throw new Error('importanceGrouping must be a positive integer');
  }
  if (!Number.isInteger(currentHeight) || currentHeight < 0) {
    throw new Error('currentHeight must be a non-negative integer');
  }
  return (Math.floor(currentHeight / importanceGrouping) + 1) * importanceGrouping;
}

/** Blocks from `currentHeight` until the next importance recalculation (1 .. importanceGrouping). */
export function blocksUntilImportanceRecalculation(
  currentHeight: number,
  importanceGrouping: number,
): number {
  return nextImportanceRecalculationHeight(currentHeight, importanceGrouping) - currentHeight;
}

/** A supplemental key is present when the node returned a non-empty public key for it. */
export function hasKey(publicKey: string | null | undefined): publicKey is string {
  return typeof publicKey === 'string' && publicKey.trim().length > 0;
}

/** Case-insensitive public key comparison (catapult-rest returns upper-case hex; users may not). */
export function sameKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return hasKey(a) && hasKey(b) && a.trim().toUpperCase() === b.trim().toUpperCase();
}
