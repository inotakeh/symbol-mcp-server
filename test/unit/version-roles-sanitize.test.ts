import { describe, expect, it } from 'vitest';
import { decodeRoles } from '../../src/domain/roles.js';
import { sanitizeUntrusted } from '../../src/domain/sanitize.js';
import { decodeVersion } from '../../src/domain/version.js';

describe('decodeVersion', () => {
  it('decodes 16777993 to 1.0.3.9', () => {
    expect(decodeVersion(16_777_993)).toBe('1.0.3.9');
  });
  it('decodes other packed values', () => {
    expect(decodeVersion(0x01000000)).toBe('1.0.0.0');
    expect(decodeVersion(0x0102030a)).toBe('1.2.3.10');
    expect(decodeVersion(0)).toBe('0.0.0.0');
  });
  it('rejects out-of-range values', () => {
    expect(() => decodeVersion(-1)).toThrow();
    expect(() => decodeVersion(2 ** 32)).toThrow();
    expect(() => decodeVersion(1.5)).toThrow();
  });
});

describe('decodeRoles', () => {
  it('expands bit flags', () => {
    expect(decodeRoles(1)).toEqual(['Peer']);
    expect(decodeRoles(2)).toEqual(['API']);
    expect(decodeRoles(4)).toEqual(['Voting']);
    expect(decodeRoles(3)).toEqual(['Peer', 'API']);
    expect(decodeRoles(7)).toEqual(['Peer', 'API', 'Voting']);
    expect(decodeRoles(0)).toEqual([]);
    expect(decodeRoles(64 | 1)).toEqual(['Peer', 'IPv4']);
  });
  it('rejects negative values', () => {
    expect(() => decodeRoles(-1)).toThrow();
  });
});

describe('sanitizeUntrusted', () => {
  it('strips control and bidi characters', () => {
    expect(sanitizeUntrusted('NO\u0007DE\u001b[31m')).toBe('NODE[31m');
    expect(sanitizeUntrusted('peer\u202Etwo\u200B')).toBe('peertwo');
    expect(sanitizeUntrusted('line1\nline2\ttab\u007F')).toBe('line1line2tab');
    expect(sanitizeUntrusted('bom\uFEFFless\u2028sep')).toBe('bomlesssep');
  });
  it('keeps ordinary unicode', () => {
    expect(sanitizeUntrusted('ノード 🚀 café')).toBe('ノード 🚀 café');
  });
  it('truncates long values', () => {
    expect(sanitizeUntrusted('a'.repeat(300))).toBe(`${'a'.repeat(256)}…`);
    expect(sanitizeUntrusted('abcdef', 3)).toBe('abc…');
  });
});
