import { describe, expect, it } from 'vitest';
import {
  bigintToHexId,
  generateNamespaceId,
  generateNamespacePath,
  isValidNamespaceName,
  isValidNamespacePath,
  namespaceNameToHexId,
} from '../../src/domain/namespace.js';

// Vectors from symbol/symbol sdk/javascript/test/symbol/idGenerator_spec.js and DESIGN-BRIEF §6.
describe('generateNamespaceId', () => {
  it('derives the root namespace "symbol"', () => {
    expect(bigintToHexId(generateNamespaceId('symbol'))).toBe('A95F1F8A96159516');
  });
  it('derives "xym" under "symbol"', () => {
    const symbol = generateNamespaceId('symbol');
    expect(bigintToHexId(generateNamespaceId('xym', symbol))).toBe('E74B99BA41F4AFEE');
  });
  it('always sets bit 63 and is case sensitive', () => {
    for (const name of ['a', 'test', 'zz-top', 'under_score', '0abc']) {
      expect(generateNamespaceId(name) >> 63n).toBe(1n);
    }
    expect(() => generateNamespaceId('Symbol')).toThrow();
  });
});

describe('paths and names', () => {
  it('maps dotted names to the leaf id', () => {
    expect(namespaceNameToHexId('symbol.xym')).toBe('E74B99BA41F4AFEE');
    expect(namespaceNameToHexId(' Symbol.XYM ')).toBe('E74B99BA41F4AFEE');
    expect(generateNamespacePath('symbol.xym').map(bigintToHexId)).toEqual([
      'A95F1F8A96159516',
      'E74B99BA41F4AFEE',
    ]);
  });
  it('validates name parts', () => {
    expect(isValidNamespaceName('symbol')).toBe(true);
    expect(isValidNamespaceName('a-b_c9')).toBe(true);
    expect(isValidNamespaceName('')).toBe(false);
    expect(isValidNamespaceName('-lead')).toBe(false);
    expect(isValidNamespaceName('has.dot')).toBe(false);
    expect(isValidNamespaceName('UPPER')).toBe(false);
    expect(isValidNamespaceName('a'.repeat(65))).toBe(false);
  });
  it('rejects invalid paths and excessive depth', () => {
    expect(isValidNamespacePath('symbol.xym')).toBe(true);
    expect(isValidNamespacePath('a.b.c')).toBe(true);
    expect(isValidNamespacePath('a.b.c.d')).toBe(false);
    expect(isValidNamespacePath('a..b')).toBe(false);
    expect(isValidNamespacePath('')).toBe(false);
  });
});
