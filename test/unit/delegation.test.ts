import { describe, expect, it } from 'vitest';
import {
  blocksUntilImportanceRecalculation,
  deriveVerdict,
  hasKey,
  nextImportanceRecalculationHeight,
  sameKey,
} from '../../src/domain/delegation.js';
import {
  isPersistentDelegationMessage,
  PERSISTENT_DELEGATION_MARKER,
} from '../../src/domain/message.js';

const s = (...statuses: Array<'ok' | 'warn' | 'fail' | 'unknown'>) =>
  statuses.map((status) => ({ status }));

describe('deriveVerdict', () => {
  it('is active when every check is ok', () => {
    expect(deriveVerdict(s('ok', 'ok', 'ok'))).toBe('active');
  });
  it('stays active when checks only warn', () => {
    expect(deriveVerdict(s('ok', 'warn', 'ok', 'warn'))).toBe('active');
  });
  it('is cannot_verify when something is unknown and nothing failed', () => {
    expect(deriveVerdict(s('ok', 'warn', 'unknown'))).toBe('cannot_verify');
  });
  it('is not_active as soon as one check fails, even with unknowns', () => {
    expect(deriveVerdict(s('ok', 'unknown', 'fail', 'warn'))).toBe('not_active');
    expect(deriveVerdict(s('fail'))).toBe('not_active');
  });
  it('treats an empty list as active (nothing contradicts it)', () => {
    expect(deriveVerdict([])).toBe('active');
  });
});

describe('importance recalculation', () => {
  it('finds the next multiple of importanceGrouping', () => {
    expect(nextImportanceRecalculationHeight(5_763_675, 720)).toBe(5_764_320);
    expect(blocksUntilImportanceRecalculation(5_763_675, 720)).toBe(645);
  });
  it('is a full grouping away when the current height is exactly a multiple', () => {
    expect(nextImportanceRecalculationHeight(1440, 720)).toBe(2160);
    expect(blocksUntilImportanceRecalculation(1440, 720)).toBe(720);
  });
  it('is one block away just before a multiple', () => {
    expect(blocksUntilImportanceRecalculation(719, 720)).toBe(1);
  });
  it('rejects a non-positive grouping or a negative height', () => {
    expect(() => nextImportanceRecalculationHeight(10, 0)).toThrow(/importanceGrouping/);
    expect(() => nextImportanceRecalculationHeight(-1, 720)).toThrow(/currentHeight/);
  });
});

describe('key helpers', () => {
  it('hasKey accepts a non-empty string only', () => {
    expect(hasKey('AB')).toBe(true);
    expect(hasKey('')).toBe(false);
    expect(hasKey('   ')).toBe(false);
    expect(hasKey(null)).toBe(false);
    expect(hasKey(undefined)).toBe(false);
  });
  it('sameKey compares case-insensitively and never matches a missing key', () => {
    expect(sameKey('abcd', 'ABCD')).toBe(true);
    expect(sameKey('abcd', 'abce')).toBe(false);
    expect(sameKey(null, null)).toBe(false);
    expect(sameKey('abcd', undefined)).toBe(false);
  });
});

describe('isPersistentDelegationMessage', () => {
  it('accepts the marker followed by a payload, in either case', () => {
    expect(isPersistentDelegationMessage(`${PERSISTENT_DELEGATION_MARKER}00`)).toBe(true);
    expect(isPersistentDelegationMessage(`${PERSISTENT_DELEGATION_MARKER.toLowerCase()}aa`)).toBe(
      true,
    );
  });
  it('rejects the marker alone (catapult requires MessageSize > 8)', () => {
    expect(isPersistentDelegationMessage(PERSISTENT_DELEGATION_MARKER)).toBe(false);
  });
  it('rejects a 0xFE message whose remaining marker bytes differ', () => {
    expect(isPersistentDelegationMessage('FE00000000000000AA')).toBe(false);
  });
  it('rejects plain, encrypted, empty and odd-length messages', () => {
    expect(isPersistentDelegationMessage('0068656C6C6F')).toBe(false);
    expect(isPersistentDelegationMessage('01AB')).toBe(false);
    expect(isPersistentDelegationMessage('')).toBe(false);
    expect(isPersistentDelegationMessage(undefined)).toBe(false);
    expect(isPersistentDelegationMessage(`${PERSISTENT_DELEGATION_MARKER}A`)).toBe(false);
  });
});
