/**
 * Symbol address handling without symbol-sdk.
 *
 * Address = 24 bytes: [network byte][20-byte RIPEMD-160(SHA3-256(publicKey))][3-byte checksum]
 * checksum = first 3 bytes of SHA3-256(first 21 bytes)
 * Encoded as RFC 4648 base32 without padding -> 39 characters. The REST API returns the
 * same 24 bytes as 48 hex characters.
 *
 * Derivation is verified in tests against the public vectors in
 * symbol/symbol tests/vectors/symbol/crypto/1.test-address.json.
 */
import { createHash } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map<string, number>([...BASE32_ALPHABET].map((c, i) => [c, i] as const));

export const ADDRESS_BYTES = 24;
export const ADDRESS_BASE32_LENGTH = 39;
export const ADDRESS_HEX_LENGTH = 48;
export const PUBLIC_KEY_HEX_LENGTH = 64;

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s.toUpperCase();
}

/** RFC 4648 base32, no padding. */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** RFC 4648 base32 decode (padding optional). Throws on invalid characters. */
export function decodeBase32(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = BASE32_LOOKUP.get(ch);
    if (v === undefined) throw new Error('invalid base32 character');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function sha3_256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha3-256').update(data).digest());
}

function ripemd160(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('ripemd160').update(data).digest());
}

function computeChecksum(first21: Uint8Array): Uint8Array {
  return sha3_256(first21).slice(0, 3);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Normalises user input: trims, drops dashes (pretty-printed addresses), upper-cases. */
export function normalizeAddressInput(value: string): string {
  return value.trim().replace(/-/g, '').toUpperCase();
}

export function isValidAddressBytes(bytes: Uint8Array): boolean {
  if (bytes.length !== ADDRESS_BYTES) return false;
  return bytesEqual(computeChecksum(bytes.slice(0, 21)), bytes.slice(21, 24));
}

/** Validates a 39-character base32 address including its checksum. */
export function isValidBase32Address(value: string): boolean {
  const s = normalizeAddressInput(value);
  if (s.length !== ADDRESS_BASE32_LENGTH || !/^[A-Z2-7]+$/.test(s)) return false;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase32(s);
  } catch {
    return false;
  }
  // 39 chars = 195 bits; the trailing 3 bits must be zero for a canonical encoding.
  if (encodeBase32(bytes) !== s) return false;
  return isValidAddressBytes(bytes);
}

export function isValidHexAddress(value: string): boolean {
  const s = value.trim().toUpperCase();
  if (s.length !== ADDRESS_HEX_LENGTH || !/^[0-9A-F]+$/.test(s)) return false;
  return isValidAddressBytes(hexToBytes(s));
}

export function isPublicKeyHex(value: string): boolean {
  const s = value.trim();
  return s.length === PUBLIC_KEY_HEX_LENGTH && /^[0-9A-Fa-f]+$/.test(s);
}

export function hexAddressToBase32(hex: string): string {
  const bytes = hexToBytes(hex.trim());
  if (bytes.length !== ADDRESS_BYTES) throw new Error('address must be 24 bytes');
  return encodeBase32(bytes);
}

export function base32AddressToHex(base32: string): string {
  const bytes = decodeBase32(normalizeAddressInput(base32));
  if (bytes.length !== ADDRESS_BYTES) throw new Error('address must decode to 24 bytes');
  return bytesToHex(bytes);
}

/** Derives the base32 address of a public key on the given network (104 mainnet, 152 testnet). */
export function publicKeyToAddress(publicKeyHex: string, networkIdentifier: number): string {
  if (!isPublicKeyHex(publicKeyHex)) throw new Error('public key must be 64 hex characters');
  if (!Number.isInteger(networkIdentifier) || networkIdentifier < 0 || networkIdentifier > 255) {
    throw new Error('network identifier must be a byte');
  }
  const publicKeyHash = sha3_256(hexToBytes(publicKeyHex));
  const ripemdHash = ripemd160(publicKeyHash);
  const first21 = new Uint8Array(21);
  first21[0] = networkIdentifier;
  first21.set(ripemdHash, 1);
  const checksum = computeChecksum(first21);
  const address = new Uint8Array(ADDRESS_BYTES);
  address.set(first21, 0);
  address.set(checksum, 21);
  return encodeBase32(address);
}

/** Network byte of an address (104 = mainnet, 152 = testnet). */
export function networkIdentifierOfAddress(base32: string): number {
  const bytes = decodeBase32(normalizeAddressInput(base32));
  const first = bytes[0];
  if (bytes.length !== ADDRESS_BYTES || first === undefined) {
    throw new Error('address must decode to 24 bytes');
  }
  return first;
}

export type AccountIdKind = 'address' | 'hexAddress' | 'publicKey' | 'invalid';

export interface ClassifiedAccountId {
  readonly kind: AccountIdKind;
  /** Canonical form usable in REST paths: base32 address or upper-case public key hex. */
  readonly canonical: string;
}

/**
 * Classifies a user-supplied account identifier. Hex addresses are converted to base32
 * because `/accounts/{accountId}` accepts base32 addresses and public keys only.
 */
export function classifyAccountId(value: string): ClassifiedAccountId {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'invalid', canonical: '' };
  if (isPublicKeyHex(trimmed)) {
    return { kind: 'publicKey', canonical: trimmed.toUpperCase() };
  }
  if (isValidHexAddress(trimmed)) {
    return { kind: 'hexAddress', canonical: hexAddressToBase32(trimmed) };
  }
  if (isValidBase32Address(trimmed)) {
    return { kind: 'address', canonical: normalizeAddressInput(trimmed) };
  }
  return { kind: 'invalid', canonical: '' };
}
