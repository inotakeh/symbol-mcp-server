/**
 * Namespace ids and names.
 *
 * id = SHA3-256(parentId as uint64 little-endian ‖ name) → first 8 bytes as uint64 LE, with
 * bit 63 set. Mirrors symbol/symbol sdk/javascript/src/symbol/idGenerator.js (fetched
 * 2026-09-10); verified in tests against its vectors: symbol → A95F1F8A96159516,
 * symbol.xym → E74B99BA41F4AFEE.
 */
import { createHash } from 'node:crypto';

export const NAMESPACE_FLAG = 1n << 63n;
export const MAX_NAMESPACE_DEPTH = 3;
export const MAX_NAMESPACE_NAME_LENGTH = 64;
/** `endHeight` of a namespace that never expires (uint64 max). */
export const UNLIMITED_END_HEIGHT = '18446744073709551615';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidNamespaceName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAMESPACE_NAME_LENGTH && NAME_PATTERN.test(name);
}

function uint64ToBytesLE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function generateNamespaceId(name: string, parentId = 0n): bigint {
  if (!isValidNamespaceName(name)) throw new Error(`invalid namespace name part: ${name}`);
  const digest = createHash('sha3-256')
    .update(uint64ToBytesLE(parentId))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  let result = 0n;
  for (let i = 0; i < 8; i++) result |= BigInt(digest[i] ?? 0) << BigInt(8 * i);
  return result | NAMESPACE_FLAG;
}

export function bigintToHexId(value: bigint): string {
  return value.toString(16).toUpperCase().padStart(16, '0');
}

/** "symbol.xym" → ids of every level, root first. Throws on an invalid name or depth. */
export function generateNamespacePath(fullyQualifiedName: string): bigint[] {
  const parts = fullyQualifiedName.trim().toLowerCase().split('.');
  if (parts.length === 0 || parts.length > MAX_NAMESPACE_DEPTH) {
    throw new Error(`namespace names have 1 to ${MAX_NAMESPACE_DEPTH} levels`);
  }
  const path: bigint[] = [];
  let parent = 0n;
  for (const part of parts) {
    const id = generateNamespaceId(part, parent);
    path.push(id);
    parent = id;
  }
  return path;
}

/** "symbol.xym" → "E74B99BA41F4AFEE". */
export function namespaceNameToHexId(fullyQualifiedName: string): string {
  const path = generateNamespacePath(fullyQualifiedName);
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('empty namespace name');
  return bigintToHexId(last);
}

export function isHexNamespaceId(value: string): boolean {
  return /^[0-9A-Fa-f]{16}$/.test(value.trim());
}

export function isValidNamespacePath(fullyQualifiedName: string): boolean {
  try {
    generateNamespacePath(fullyQualifiedName);
    return true;
  } catch {
    return false;
  }
}
