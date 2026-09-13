/**
 * Transfer message decoding.
 *
 * catapult-rest returns `transaction.message` as hex (absent when empty). The first byte is the
 * message type: 0x00 plain UTF-8 text, 0x01 encrypted (undecryptable here), 0xFE persistent
 * harvesting delegation. Anything else is reported as raw hex.
 *
 * Message text is written by third parties (DESIGN-BRIEF §2-8): it is sanitised and exposed under
 * the `messageText` name so consumers know it is untrusted.
 */
import { sanitizeUntrusted } from './sanitize.js';

export type MessageKind =
  | 'empty'
  | 'plain'
  | 'encrypted'
  | 'persistentHarvestingDelegation'
  | 'raw';

export interface DecodedMessage {
  readonly kind: MessageKind;
  /** Sanitised plain text (untrusted, third-party content). Only for kind 'plain'. */
  readonly messageText?: string;
  /** Human-readable note for non-plain kinds. */
  readonly note?: string;
  readonly sizeBytes: number;
}

export const MAX_MESSAGE_TEXT_LENGTH = 1024;

/**
 * First 8 bytes of a persistent harvesting delegation request message.
 *
 * Sources (fetched 2026-09-13):
 * - symbol/symbol sdk/javascript/src/symbol/MessageEncoder.js:
 *   `DELEGATION_MARKER = Uint8Array.from(Buffer.from('FE2A8061577301E2', 'hex'))`, prepended by
 *   `encodePersistentHarvestingDelegation(nodePublicKey, remoteKeyPair, vrfKeyPair)`.
 * - catapult plugins/txes/transfer/src/plugins/TransferPlugin.cpp registers
 *   `CreateTransferMessageObserver(0xE201735761802AFE, recipient, ...)`; the observer
 *   (observers/TransferMessageObserver.cpp) reads the first 8 message bytes as a little-endian
 *   uint64 (0xE201735761802AFE == bytes FE 2A 80 61 57 73 01 E2) and requires
 *   `MessageSize > Marker_Size`. `recipient` is `PublicKeyToAddress(encryptionPublicKey)`, the
 *   node's transport key (node.key.pem), which catapult-rest exposes as `nodePublicKey`.
 */
export const PERSISTENT_DELEGATION_MARKER = 'FE2A8061577301E2';

/** True when a hex message is a persistent delegation request (marker plus a non-empty payload). */
export function isPersistentDelegationMessage(hex: string | undefined): boolean {
  const clean = (hex ?? '').trim().toUpperCase();
  return (
    clean.length > PERSISTENT_DELEGATION_MARKER.length &&
    clean.length % 2 === 0 &&
    /^[0-9A-F]+$/.test(clean) &&
    clean.startsWith(PERSISTENT_DELEGATION_MARKER)
  );
}

export function decodeMessage(hex: string | undefined): DecodedMessage {
  const clean = (hex ?? '').trim();
  if (clean.length === 0) return { kind: 'empty', sizeBytes: 0 };
  if (clean.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(clean)) {
    return { kind: 'raw', note: 'message is not valid hex', sizeBytes: 0 };
  }
  const bytes = Buffer.from(clean, 'hex');
  const type = bytes[0];
  const body = bytes.subarray(1);
  switch (type) {
    case 0x00:
      return {
        kind: 'plain',
        messageText: sanitizeUntrusted(body.toString('utf8'), MAX_MESSAGE_TEXT_LENGTH),
        sizeBytes: bytes.length,
      };
    case 0x01:
      return {
        kind: 'encrypted',
        note: 'Encrypted message (cannot be decrypted without the recipient private key).',
        sizeBytes: bytes.length,
      };
    case 0xfe:
      return {
        kind: 'persistentHarvestingDelegation',
        note: 'Persistent harvesting delegation request (encrypted key material for a node).',
        sizeBytes: bytes.length,
      };
    default:
      return {
        kind: 'raw',
        note: `Unknown message type 0x${(type ?? 0).toString(16).toUpperCase().padStart(2, '0')}.`,
        sizeBytes: bytes.length,
      };
  }
}
