import { describe, expect, it } from 'vitest';
import {
  base32AddressToHex,
  classifyAccountId,
  decodeBase32,
  encodeBase32,
  hexAddressToBase32,
  isValidBase32Address,
  isValidHexAddress,
  networkIdentifierOfAddress,
  publicKeyToAddress,
} from '../../src/domain/address.js';
import { fixture } from '../tools/harness.js';

interface Vectors {
  vectors: Array<{ publicKey: string; address_Public: string; address_PublicTest: string }>;
  fixture: { publicKey: string; hex: string; base32: string };
}

const data = fixture<Vectors>('address-vectors.json');

describe('base32', () => {
  it('round-trips 24-byte values', () => {
    const bytes = Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 255);
    expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    expect(encodeBase32(bytes)).toHaveLength(39);
  });
  it('rejects invalid characters', () => {
    expect(() => decodeBase32('NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYU1')).toThrow();
  });
});

describe('hex <-> base32', () => {
  it('converts the fixture account both ways', () => {
    expect(hexAddressToBase32(data.fixture.hex)).toBe(data.fixture.base32);
    expect(base32AddressToHex(data.fixture.base32)).toBe(data.fixture.hex);
  });
  it('accepts dashed / lower-case input', () => {
    expect(base32AddressToHex('ncv5h-rbsfe-gtpnb-iupbv-agwxw-xz43c-4tnoq-uyuy')).toBe(
      data.fixture.hex,
    );
  });
});

describe('publicKeyToAddress (symbol/symbol test vectors)', () => {
  for (const v of data.vectors) {
    it(`derives ${v.address_Public}`, () => {
      expect(publicKeyToAddress(v.publicKey, 104)).toBe(v.address_Public);
      expect(publicKeyToAddress(v.publicKey, 152)).toBe(v.address_PublicTest);
    });
  }
  it('derives the fixture account address from its public key (fixture consistency)', () => {
    expect(publicKeyToAddress(data.fixture.publicKey, 104)).toBe(data.fixture.base32);
  });
  it('rejects non-key input', () => {
    expect(() => publicKeyToAddress('abc', 104)).toThrow();
  });
});

describe('validation', () => {
  it('accepts valid addresses and detects checksum errors', () => {
    expect(isValidBase32Address(data.fixture.base32)).toBe(true);
    // flip the last character
    const broken = `${data.fixture.base32.slice(0, -1)}${data.fixture.base32.endsWith('A') ? 'B' : 'A'}`;
    expect(isValidBase32Address(broken)).toBe(false);
    expect(isValidBase32Address(data.fixture.base32.slice(0, 38))).toBe(false);
    expect(isValidHexAddress(data.fixture.hex)).toBe(true);
    expect(isValidHexAddress(`${data.fixture.hex.slice(0, -2)}00`)).toBe(false);
  });
  it('reads the network byte', () => {
    expect(networkIdentifierOfAddress(data.fixture.base32)).toBe(104);
    expect(networkIdentifierOfAddress(data.vectors[0]?.address_PublicTest ?? '')).toBe(152);
  });
});

describe('classifyAccountId', () => {
  it('classifies base32 addresses', () => {
    expect(classifyAccountId(` ${data.fixture.base32.toLowerCase()} `)).toEqual({
      kind: 'address',
      canonical: data.fixture.base32,
    });
  });
  it('converts hex addresses to base32', () => {
    expect(classifyAccountId(data.fixture.hex)).toEqual({
      kind: 'hexAddress',
      canonical: data.fixture.base32,
    });
  });
  it('classifies public keys and upper-cases them', () => {
    expect(classifyAccountId(data.fixture.publicKey.toLowerCase())).toEqual({
      kind: 'publicKey',
      canonical: data.fixture.publicKey,
    });
  });
  it('classifies namespace names as given (lower-case, up to three levels)', () => {
    expect(classifyAccountId('alice')).toEqual({ kind: 'namespace', canonical: 'alice' });
    expect(classifyAccountId(' alice.pay ')).toEqual({ kind: 'namespace', canonical: 'alice.pay' });
    expect(classifyAccountId('a-b_c9.x.y')).toEqual({ kind: 'namespace', canonical: 'a-b_c9.x.y' });
    // 'not-an-address' is a syntactically valid root namespace name.
    expect(classifyAccountId('not-an-address').kind).toBe('namespace');
  });
  it('lets a lower-case 39-character string that fails the address checksum fall through to namespace', () => {
    const lower = data.fixture.base32.toLowerCase();
    const broken = `${lower.slice(0, -1)}${lower.endsWith('a') ? 'b' : 'a'}`;
    expect(broken).toHaveLength(39);
    expect(classifyAccountId(broken)).toEqual({ kind: 'namespace', canonical: broken });
    // The same typo in upper case is neither an address nor a namespace name.
    expect(classifyAccountId(broken.toUpperCase()).kind).toBe('invalid');
    // A correct address wins over the namespace rule even in lower case.
    expect(classifyAccountId(lower).kind).toBe('address');
    // A lower-case public key is a key, not a 64-character namespace name.
    expect(classifyAccountId(data.fixture.publicKey.toLowerCase()).kind).toBe('publicKey');
  });
  it('rejects everything else', () => {
    expect(classifyAccountId('').kind).toBe('invalid');
    expect(classifyAccountId('A'.repeat(40)).kind).toBe('invalid');
    // 63 digits is a syntactically valid namespace name (max 64), so it is not invalid.
    expect(classifyAccountId('0'.repeat(63)).kind).toBe('namespace');
    expect(classifyAccountId('0'.repeat(65)).kind).toBe('invalid');
    expect(classifyAccountId('ALICE').kind).toBe('invalid');
    expect(classifyAccountId('alice pay').kind).toBe('invalid');
    expect(classifyAccountId('a.b.c.d').kind).toBe('invalid');
    expect(classifyAccountId('a..b').kind).toBe('invalid');
    expect(classifyAccountId('.a').kind).toBe('invalid');
    expect(classifyAccountId('a.').kind).toBe('invalid');
    expect(classifyAccountId('-alice').kind).toBe('invalid');
    expect(classifyAccountId('a'.repeat(65)).kind).toBe('invalid');
  });
});
