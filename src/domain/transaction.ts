/**
 * Turns a catapult-rest transaction (confirmed, unconfirmed, partial or embedded) into the
 * task-level summary shared by symbol_transaction_get and symbol_transaction_search. Pure: all
 * network lookups (mosaic aliases/divisibility, namespace names) are done by the caller and
 * passed in as maps.
 */
import type { EmbeddedTransactionInfo, TransactionInfo } from '../client/schemas.js';
import { hexAddressToBase32, hexToBytes, publicKeyToAddress } from './address.js';
import { formatAmount } from './amount.js';
import { parseHeight } from './epoch.js';
import { type DecodedMessage, decodeMessage } from './message.js';
import { formatInstant, type Instant, networkTimestampToDate } from './time.js';
import { extractTransactionDetails, type TransactionDetails } from './txdetails.js';
import { describeTransactionType, type TransactionTypeInfo } from './txtype.js';

export interface MosaicMeta {
  readonly alias: string | null;
  readonly divisibility: number | null;
}

export interface SummarizeOptions {
  readonly networkIdentifier: number;
  readonly epochAdjustmentSeconds: number;
  /** Divisibility of the currency mosaic, used to format fees. */
  readonly currencyDivisibility: number;
  readonly timeZone?: string | undefined;
  /** Upper-case mosaic id -> alias/divisibility (null when unknown). */
  readonly mosaicMeta: ReadonlyMap<string, MosaicMeta>;
  /** Upper-case namespace id -> full dotted name, for alias recipients. */
  readonly namespaceNames: ReadonlyMap<string, string>;
}

export interface MosaicSummary {
  readonly id: string;
  readonly alias: string | null;
  readonly amount: string;
  readonly rawAmount: string;
  readonly divisibility: number | null;
}

export interface RecipientSummary {
  /** Base32 address, or null when the recipient is a namespace alias that could not be resolved. */
  readonly address: string | null;
  /** Set when the transaction targets a namespace alias instead of a concrete address. */
  readonly namespaceId: string | null;
  readonly namespaceName: string | null;
}

export interface EmbeddedSummary {
  readonly index: number;
  readonly type: TransactionTypeInfo;
  readonly signer: { readonly publicKey: string; readonly address: string };
  readonly recipient: RecipientSummary | null;
  readonly mosaics: MosaicSummary[];
  readonly message: DecodedMessage | null;
  readonly details: TransactionDetails;
}

export interface TransactionSummary {
  readonly hash: string | null;
  readonly type: TransactionTypeInfo;
  readonly height: number | null;
  readonly timestamp: Instant | null;
  readonly deadline: Instant | null;
  readonly signer: { readonly publicKey: string; readonly address: string };
  readonly recipient: RecipientSummary | null;
  readonly mosaics: MosaicSummary[];
  readonly message: DecodedMessage | null;
  readonly fee: {
    readonly maxFee: string | null;
    readonly rawMaxFee: string | null;
    readonly paidFee: string | null;
    readonly rawPaidFee: string | null;
    readonly feeMultiplier: number | null;
    readonly sizeBytes: number | null;
  };
  readonly details: TransactionDetails;
  readonly innerTransactions: EmbeddedSummary[];
  readonly cosignatureCount: number;
}

export interface ParsedUnresolvedAddress {
  readonly kind: 'address' | 'namespace';
  readonly base32?: string;
  readonly namespaceId?: string;
}

/**
 * An UnresolvedAddress is 24 bytes: either a plain address, or (when bit 0 of the network byte is
 * set) a namespace alias whose 8-byte little-endian id follows the network byte.
 */
export function parseUnresolvedAddress(hex: string): ParsedUnresolvedAddress {
  const bytes = hexToBytes(hex.trim());
  const first = bytes[0] ?? 0;
  if ((first & 0x01) === 1) {
    let id = 0n;
    for (let i = 8; i >= 1; i--) id = (id << 8n) | BigInt(bytes[i] ?? 0);
    return { kind: 'namespace', namespaceId: id.toString(16).toUpperCase().padStart(16, '0') };
  }
  return { kind: 'address', base32: hexAddressToBase32(hex) };
}

function summarizeRecipient(
  hex: string | undefined,
  opts: SummarizeOptions,
): RecipientSummary | null {
  if (!hex) return null;
  const parsed = parseUnresolvedAddress(hex);
  if (parsed.kind === 'address') {
    return { address: parsed.base32 ?? null, namespaceId: null, namespaceName: null };
  }
  const namespaceId = parsed.namespaceId ?? null;
  return {
    address: null,
    namespaceId,
    namespaceName: namespaceId ? (opts.namespaceNames.get(namespaceId) ?? null) : null,
  };
}

function summarizeMosaics(
  mosaics: ReadonlyArray<{ id: string; amount: string }> | undefined,
  opts: SummarizeOptions,
): MosaicSummary[] {
  return (mosaics ?? []).map((m) => {
    const id = m.id.toUpperCase();
    const meta = opts.mosaicMeta.get(id);
    const divisibility = meta?.divisibility ?? null;
    return {
      id,
      alias: meta?.alias ?? null,
      amount: divisibility === null ? m.amount : formatAmount(m.amount, divisibility),
      rawAmount: m.amount,
      divisibility,
    };
  });
}

function toInstant(networkTimestamp: string | undefined, opts: SummarizeOptions): Instant | null {
  if (networkTimestamp === undefined) return null;
  return formatInstant(
    networkTimestampToDate(networkTimestamp, opts.epochAdjustmentSeconds),
    opts.timeZone,
  );
}

export function summarizeEmbedded(
  info: EmbeddedTransactionInfo,
  opts: SummarizeOptions,
): EmbeddedSummary {
  const tx = info.transaction;
  const hasMessage = tx.message !== undefined || tx.type === 0x4154;
  return {
    index: info.meta.index ?? 0,
    type: describeTransactionType(tx.type),
    signer: {
      publicKey: tx.signerPublicKey.toUpperCase(),
      address: publicKeyToAddress(tx.signerPublicKey, opts.networkIdentifier),
    },
    recipient: summarizeRecipient(tx.recipientAddress, opts),
    mosaics: summarizeMosaics(tx.mosaics, opts),
    message: hasMessage ? decodeMessage(tx.message) : null,
    details: extractTransactionDetails(tx),
  };
}

export function summarizeTransaction(
  info: TransactionInfo,
  opts: SummarizeOptions,
): TransactionSummary {
  const tx = info.transaction;
  const meta = info.meta;
  const feeDivisibility = opts.currencyDivisibility;
  const height = meta.height !== undefined ? parseHeight(meta.height) : null;
  const size = tx.size ?? null;
  const feeMultiplier = meta.feeMultiplier ?? null;
  const rawPaidFee =
    size !== null && feeMultiplier !== null
      ? (BigInt(size) * BigInt(feeMultiplier)).toString()
      : null;
  const hasMessage = tx.message !== undefined || tx.type === 0x4154;

  return {
    hash: meta.hash?.toUpperCase() ?? null,
    type: describeTransactionType(tx.type),
    height: height === 0 ? null : height,
    timestamp: toInstant(meta.timestamp, opts),
    deadline: toInstant(tx.deadline, opts),
    signer: {
      publicKey: tx.signerPublicKey.toUpperCase(),
      address: publicKeyToAddress(tx.signerPublicKey, opts.networkIdentifier),
    },
    recipient: summarizeRecipient(tx.recipientAddress, opts),
    mosaics: summarizeMosaics(tx.mosaics, opts),
    message: hasMessage ? decodeMessage(tx.message) : null,
    fee: {
      maxFee: tx.maxFee !== undefined ? formatAmount(tx.maxFee, feeDivisibility) : null,
      rawMaxFee: tx.maxFee ?? null,
      paidFee: rawPaidFee !== null ? formatAmount(rawPaidFee, feeDivisibility) : null,
      rawPaidFee,
      feeMultiplier,
      sizeBytes: size,
    },
    details: extractTransactionDetails(tx),
    innerTransactions: (tx.transactions ?? []).map((inner) => summarizeEmbedded(inner, opts)),
    cosignatureCount: tx.cosignatures?.length ?? 0,
  };
}

/** Every mosaic id referenced by a transaction and its embedded transactions (upper-case). */
export function collectMosaicIds(info: TransactionInfo): string[] {
  const ids = new Set<string>();
  for (const m of info.transaction.mosaics ?? []) ids.add(m.id.toUpperCase());
  for (const inner of info.transaction.transactions ?? []) {
    for (const m of inner.transaction.mosaics ?? []) ids.add(m.id.toUpperCase());
  }
  return [...ids];
}

/** Every namespace id used as an alias recipient (upper-case). */
export function collectRecipientNamespaceIds(info: TransactionInfo): string[] {
  const ids = new Set<string>();
  const consider = (hex: string | undefined) => {
    if (!hex) return;
    const parsed = parseUnresolvedAddress(hex);
    if (parsed.kind === 'namespace' && parsed.namespaceId) ids.add(parsed.namespaceId);
  };
  consider(info.transaction.recipientAddress);
  for (const inner of info.transaction.transactions ?? [])
    consider(inner.transaction.recipientAddress);
  return [...ids];
}
