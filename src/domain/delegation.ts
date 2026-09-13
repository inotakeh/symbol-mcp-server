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
