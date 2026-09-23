/**
 * Type-specific transaction details, typed per transaction kind.
 *
 * Field names follow the catapult-rest transaction body DTOs (symbol/symbol-openapi
 * spec/plugins/<plugin>/schemas/*TransactionBodyDTO.yml, fetched 2026-09-10). Enum codes:
 * LinkAction 0 unlink / 1 link; AliasAction 0 unlink / 1 link; MosaicSupplyChangeAction
 * 0 decrease / 1 increase; NamespaceRegistrationType 0 root / 1 child; LockHashAlgorithm
 * 0 SHA3_256 / 1 HASH_160 / 2 HASH_256; MosaicRestrictionType 0 NONE, 1 EQ, 2 NE, 3 LT, 4 LE,
 * 5 GT, 6 GE; AccountRestrictionFlags bits 0x0001 address, 0x0002 mosaic, 0x0004 transaction
 * type, 0x4000 outgoing, 0x8000 block.
 *
 * Transfers and aggregates carry no extra details (recipient/mosaics/message are top-level).
 * Unknown types, or known types whose fields do not parse, fall back to `kind: "other"` with the
 * scalar fields the node returned, names and values cleaned like any untrusted text.
 *
 * Fields are only accepted in the form the REST API documents, so nothing else reaches the typed
 * output: scopedMetadataKey (MetadataKey) and restrictionKey (RestrictionKeyHex) are exactly 16 hex
 * digits, the voting key of a VotingKeyLink (VotingKey) is 64, and account restriction values are
 * an address (48 hex), a mosaic id (16 hex) or a transaction type code.
 */
import * as z from 'zod/v4';
import { hexAddressToBase32, hexToBytes } from './address.js';
import { cleanUntrusted, type UntrustedText } from './sanitize.js';

const Hex16 = z.string().regex(/^[0-9A-Fa-f]{16}$/);
const Hex48 = z.string().regex(/^[0-9A-Fa-f]{48}$/);
const Hex64 = z.string().regex(/^[0-9A-Fa-f]{64}$/);
const Uint64 = z.string().regex(/^\d+$/);

/**
 * Longest SecretProof proof in hex: catbuffer declares `proof_size = uint16`, so a proof has at most
 * 65,535 bytes. A longer value cannot come from the chain and falls back to kind "other".
 */
export const MAX_PROOF_HEX_LENGTH = 2 * 65_535;

/** Scalar fields kept for a transaction without a typed shape; real bodies have far fewer. */
export const MAX_OTHER_FIELDS = 32;

/** Longest field name kept in kind "other": the names come from the node as well. */
export const MAX_OTHER_FIELD_NAME_LENGTH = 64;

const FlagsSchema = z.object({
  supplyMutable: z.boolean(),
  transferable: z.boolean(),
  restrictable: z.boolean(),
  revokable: z.boolean(),
  raw: z.number(),
});

/** Portable nullable (anyOf with a described branch), mirroring tools/_shared nullable(). */
const nullableString = (description: string) =>
  z.union([z.string().describe(description), z.null()]);

const AddressText = z
  .string()
  .describe('Base32 address, or "alias:<namespaceId>" when the node returned a namespace alias.');

const ScalarSchema = z.union([
  z.string().describe('string field'),
  z.number().describe('numeric field'),
  z.boolean().describe('boolean field'),
  z.null().describe('null field'),
]);

export const TransactionDetailsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('keyLink'),
    linkedPublicKey: z.string(),
    linkAction: z.enum(['link', 'unlink']),
  }),
  z.object({
    kind: z.literal('votingKeyLink'),
    linkedPublicKey: z.string(),
    startEpoch: z.number(),
    endEpoch: z.number(),
    linkAction: z.enum(['link', 'unlink']),
  }),
  z.object({
    kind: z.literal('namespaceRegistration'),
    id: z.string(),
    name: z.string().describe('Namespace name part (untrusted, sanitized).'),
    registrationType: z.enum(['root', 'child']),
    duration: nullableString('Blocks (root only); null for a child.'),
    parentId: nullableString('Parent namespace id (child only); null for a root.'),
  }),
  z.object({
    kind: z.literal('mosaicDefinition'),
    id: z.string(),
    nonce: z.number(),
    flags: FlagsSchema,
    divisibility: z.number(),
    duration: z.string().describe('Blocks; "0" means unlimited.'),
  }),
  z.object({
    kind: z.literal('mosaicSupplyChange'),
    mosaicId: z.string(),
    action: z.enum(['increase', 'decrease']),
    delta: z.string().describe('Raw supply delta.'),
  }),
  z.object({
    kind: z.literal('mosaicSupplyRevocation'),
    mosaicId: z.string(),
    amount: z.string().describe('Raw amount revoked.'),
    sourceAddress: AddressText,
  }),
  z.object({
    kind: z.literal('addressAlias'),
    namespaceId: z.string(),
    address: z.string(),
    aliasAction: z.enum(['link', 'unlink']),
  }),
  z.object({
    kind: z.literal('mosaicAlias'),
    namespaceId: z.string(),
    mosaicId: z.string(),
    aliasAction: z.enum(['link', 'unlink']),
  }),
  z.object({
    kind: z.literal('hashLock'),
    mosaicId: z.string(),
    amount: z.string().describe('Raw locked amount.'),
    duration: z.string().describe('Blocks.'),
    hash: z.string().describe('Hash of the aggregate bonded transaction being locked for.'),
  }),
  z.object({
    kind: z.literal('secretLock'),
    mosaicId: z.string(),
    amount: z.string().describe('Raw locked amount.'),
    duration: z.string().describe('Blocks.'),
    secret: z.string(),
    hashAlgorithm: z.object({ code: z.number(), name: z.string() }),
    recipientAddress: AddressText,
  }),
  z.object({
    kind: z.literal('secretProof'),
    secret: z.string(),
    proof: z.string().describe('Hex proof.'),
    hashAlgorithm: z.object({ code: z.number(), name: z.string() }),
    recipientAddress: AddressText,
  }),
  z.object({
    kind: z.literal('multisigAccountModification'),
    minApprovalDelta: z.number(),
    minRemovalDelta: z.number(),
    addressAdditions: z.array(AddressText),
    addressDeletions: z.array(AddressText),
  }),
  z.object({
    kind: z.literal('metadata'),
    metadataType: z.enum(['account', 'mosaic', 'namespace']),
    targetAddress: AddressText,
    scopedMetadataKey: z.string(),
    targetMosaicId: nullableString('Only for mosaic metadata.'),
    targetNamespaceId: nullableString('Only for namespace metadata.'),
    valueSizeDelta: z.number(),
    valueSize: z.number(),
    value: z.string().describe('Metadata value as returned by the node (hex; untrusted).'),
  }),
  z.object({
    kind: z.literal('accountRestriction'),
    restrictionType: z.enum(['address', 'mosaicId', 'transactionType']),
    direction: z.enum(['incoming', 'outgoing']),
    mode: z.enum(['allow', 'block']),
    restrictionFlags: z.number(),
    restrictionAdditions: z.array(z.string()),
    restrictionDeletions: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('mosaicAddressRestriction'),
    mosaicId: z.string(),
    restrictionKey: z.string(),
    targetAddress: AddressText,
    previousRestrictionValue: z.string(),
    newRestrictionValue: z.string(),
  }),
  z.object({
    kind: z.literal('mosaicGlobalRestriction'),
    mosaicId: z.string(),
    referenceMosaicId: z.string(),
    restrictionKey: z.string(),
    previousRestrictionValue: z.string(),
    newRestrictionValue: z.string(),
    previousRestrictionType: z.object({ code: z.number(), name: z.string() }),
    newRestrictionType: z.object({ code: z.number(), name: z.string() }),
  }),
  z.object({
    kind: z.literal('other'),
    fields: z
      .record(z.string(), ScalarSchema)
      .describe('Scalar fields returned by the node for a type without a dedicated shape.'),
  }),
]);

export type TransactionDetails = z.output<typeof TransactionDetailsSchema>;

const LINK_ACTIONS = { 0: 'unlink', 1: 'link' } as const;
const SUPPLY_ACTIONS = { 0: 'decrease', 1: 'increase' } as const;
const REGISTRATION_TYPES = { 0: 'root', 1: 'child' } as const;
const HASH_ALGORITHMS: Record<number, string> = { 0: 'SHA3_256', 1: 'HASH_160', 2: 'HASH_256' };
const RESTRICTION_TYPES: Record<number, string> = {
  0: 'NONE',
  1: 'EQ',
  2: 'NE',
  3: 'LT',
  4: 'LE',
  5: 'GT',
  6: 'GE',
};

const linkAction = z.union([z.literal(0), z.literal(1)]).transform((v) => LINK_ACTIONS[v]);
const supplyAction = z.union([z.literal(0), z.literal(1)]).transform((v) => SUPPLY_ACTIONS[v]);
const registrationType = z
  .union([z.literal(0), z.literal(1)])
  .transform((v) => REGISTRATION_TYPES[v]);
const named = (table: Record<number, string>) =>
  z
    .number()
    .int()
    .transform((code) => ({ code, name: table[code] ?? `Unknown(${code})` }));

/** Base32 for a plain address; "alias:<id>" for a namespace-alias unresolved address. */
function addressText(hex: string): string {
  const bytes = hexToBytes(hex);
  if (((bytes[0] ?? 0) & 0x01) === 1) {
    let id = 0n;
    for (let i = 8; i >= 1; i--) id = (id << 8n) | BigInt(bytes[i] ?? 0);
    return `alias:${id.toString(16).toUpperCase().padStart(16, '0')}`;
  }
  return hexAddressToBase32(hex);
}
const address = Hex48.transform(addressText);
const upperHex16 = Hex16.transform((v) => v.toUpperCase());
const upperHex64 = Hex64.transform((v) => v.toUpperCase());

const keyLink = z.object({ linkedPublicKey: upperHex64, linkAction });
const votingKeyLink = z.object({
  linkedPublicKey: upperHex64,
  startEpoch: z.number().int(),
  endEpoch: z.number().int(),
  linkAction,
});
const namespaceRegistration = z.object({
  id: upperHex16,
  // Untrusted: cleaned after parsing, through the call's UntrustedText (not in the schema).
  name: z.string(),
  registrationType,
  duration: Uint64.optional(),
  parentId: upperHex16.optional(),
});
const mosaicDefinition = z.object({
  id: upperHex16,
  nonce: z.number().int(),
  flags: z.number().int(),
  divisibility: z.number().int(),
  duration: Uint64,
});
const mosaicSupplyChange = z.object({ mosaicId: upperHex16, delta: Uint64, action: supplyAction });
const mosaicSupplyRevocation = z.object({
  sourceAddress: address,
  mosaicId: upperHex16,
  amount: Uint64,
});
const addressAlias = z.object({
  namespaceId: upperHex16,
  address: Hex48.transform(hexAddressToBase32),
  aliasAction: linkAction,
});
const mosaicAlias = z.object({
  namespaceId: upperHex16,
  mosaicId: upperHex16,
  aliasAction: linkAction,
});
const hashLock = z.object({
  mosaicId: upperHex16,
  amount: Uint64,
  duration: Uint64,
  hash: upperHex64,
});
const secretLock = z.object({
  recipientAddress: address,
  secret: upperHex64,
  mosaicId: upperHex16,
  amount: Uint64,
  duration: Uint64,
  hashAlgorithm: named(HASH_ALGORITHMS),
});
const secretProof = z.object({
  recipientAddress: address,
  secret: upperHex64,
  hashAlgorithm: named(HASH_ALGORITHMS),
  proof: z
    .string()
    .max(MAX_PROOF_HEX_LENGTH)
    .regex(/^[0-9A-Fa-f]*$/)
    .transform((v) => v.toUpperCase()),
});
const multisig = z.object({
  minRemovalDelta: z.number().int(),
  minApprovalDelta: z.number().int(),
  addressAdditions: z.array(address),
  addressDeletions: z.array(address),
});
const metadata = z.object({
  targetAddress: address,
  scopedMetadataKey: upperHex16,
  targetMosaicId: upperHex16.optional(),
  targetNamespaceId: upperHex16.optional(),
  valueSizeDelta: z.number().int(),
  valueSize: z.number().int(),
  // Untrusted: cleaned after parsing, through the call's UntrustedText (not in the schema).
  value: z.string(),
});
/** An account restriction value: an address, a mosaic id or a transaction type code. */
const restrictionValue = z.union([Hex48, Hex16, z.number().int()]);
const accountRestriction = z.object({
  restrictionFlags: z.number().int(),
  restrictionAdditions: z.array(restrictionValue),
  restrictionDeletions: z.array(restrictionValue),
});
const mosaicAddressRestriction = z.object({
  mosaicId: upperHex16,
  restrictionKey: upperHex16,
  previousRestrictionValue: Uint64,
  newRestrictionValue: Uint64,
  targetAddress: address,
});
const mosaicGlobalRestriction = z.object({
  mosaicId: upperHex16,
  referenceMosaicId: upperHex16,
  restrictionKey: upperHex16,
  previousRestrictionValue: Uint64,
  newRestrictionValue: Uint64,
  previousRestrictionType: named(RESTRICTION_TYPES),
  newRestrictionType: named(RESTRICTION_TYPES),
});

/** An address as base32 (or alias), a mosaic id in upper case, a transaction type as its code. */
function restrictionItem(value: string | number): string {
  if (typeof value === 'number') return String(value);
  return value.length === 48 ? addressText(value) : value.toUpperCase();
}

function otherDetails(
  tx: Readonly<Record<string, unknown>>,
  text: UntrustedText,
): TransactionDetails {
  const skip = new Set([
    'signature',
    'signerPublicKey',
    'version',
    'network',
    'type',
    'maxFee',
    'deadline',
    'size',
    'recipientAddress',
    'mosaics',
    'message',
    'transactions',
    'cosignatures',
    'transactionsHash',
  ]);
  const fields = new Map<string, string | number | boolean | null>();
  for (const [rawKey, value] of Object.entries(tx)) {
    if (fields.size >= MAX_OTHER_FIELDS) break;
    // The body DTO is loose, so the field names are the node's text as much as the values are.
    // Two names that clean to the same text keep the first, so a look-alike cannot replace it.
    // Only names and values that reach the output are counted.
    const key = cleanUntrusted(rawKey, MAX_OTHER_FIELD_NAME_LENGTH);
    if (key.text === '' || skip.has(key.text) || fields.has(key.text)) continue;
    if (typeof value === 'string') fields.set(text.use(key), text.clean(value));
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      fields.set(text.use(key), value);
    }
  }
  // fromEntries defines own properties, so a name such as "__proto__" stays an ordinary field.
  return { kind: 'other', fields: Object.fromEntries(fields) };
}

/**
 * Extracts typed details from a raw catapult-rest transaction object by its type code. The text
 * written by others (namespace names, metadata values, unknown fields) is cleaned through the
 * call's `text`, which counts what it lost.
 */
export function extractTransactionDetails(
  tx: Readonly<Record<string, unknown>> & { readonly type: number },
  text: UntrustedText,
): TransactionDetails {
  const parse = <T>(schema: z.ZodType<T>): T | undefined => {
    const r = schema.safeParse(tx);
    return r.success ? r.data : undefined;
  };
  switch (tx.type) {
    case 0x4154: // Transfer
    case 0x4141: // AggregateComplete
    case 0x4241: // AggregateBonded
      return { kind: 'none' };
    case 0x414c: // AccountKeyLink
    case 0x424c: // NodeKeyLink
    case 0x4243: {
      // VrfKeyLink
      const d = parse(keyLink);
      return d ? { kind: 'keyLink', ...d } : otherDetails(tx, text);
    }
    case 0x4143: {
      const d = parse(votingKeyLink);
      return d ? { kind: 'votingKeyLink', ...d } : otherDetails(tx, text);
    }
    case 0x414e: {
      const d = parse(namespaceRegistration);
      return d
        ? {
            kind: 'namespaceRegistration',
            id: d.id,
            name: text.clean(d.name, 64),
            registrationType: d.registrationType,
            duration: d.registrationType === 'root' ? (d.duration ?? null) : null,
            parentId: d.registrationType === 'child' ? (d.parentId ?? null) : null,
          }
        : otherDetails(tx, text);
    }
    case 0x414d: {
      const d = parse(mosaicDefinition);
      return d
        ? {
            kind: 'mosaicDefinition',
            id: d.id,
            nonce: d.nonce,
            flags: {
              supplyMutable: (d.flags & 1) !== 0,
              transferable: (d.flags & 2) !== 0,
              restrictable: (d.flags & 4) !== 0,
              revokable: (d.flags & 8) !== 0,
              raw: d.flags,
            },
            divisibility: d.divisibility,
            duration: d.duration,
          }
        : otherDetails(tx, text);
    }
    case 0x424d: {
      const d = parse(mosaicSupplyChange);
      return d ? { kind: 'mosaicSupplyChange', ...d } : otherDetails(tx, text);
    }
    case 0x434d: {
      const d = parse(mosaicSupplyRevocation);
      return d ? { kind: 'mosaicSupplyRevocation', ...d } : otherDetails(tx, text);
    }
    case 0x424e: {
      const d = parse(addressAlias);
      return d ? { kind: 'addressAlias', ...d } : otherDetails(tx, text);
    }
    case 0x434e: {
      const d = parse(mosaicAlias);
      return d ? { kind: 'mosaicAlias', ...d } : otherDetails(tx, text);
    }
    case 0x4148: {
      const d = parse(hashLock);
      return d ? { kind: 'hashLock', ...d } : otherDetails(tx, text);
    }
    case 0x4152: {
      const d = parse(secretLock);
      return d ? { kind: 'secretLock', ...d } : otherDetails(tx, text);
    }
    case 0x4252: {
      const d = parse(secretProof);
      return d ? { kind: 'secretProof', ...d } : otherDetails(tx, text);
    }
    case 0x4155: {
      const d = parse(multisig);
      return d ? { kind: 'multisigAccountModification', ...d } : otherDetails(tx, text);
    }
    case 0x4144:
    case 0x4244:
    case 0x4344: {
      const d = parse(metadata);
      if (!d) return otherDetails(tx, text);
      const metadataType =
        tx.type === 0x4144 ? 'account' : tx.type === 0x4244 ? 'mosaic' : 'namespace';
      return {
        kind: 'metadata',
        metadataType,
        targetAddress: d.targetAddress,
        scopedMetadataKey: d.scopedMetadataKey,
        targetMosaicId: d.targetMosaicId ?? null,
        targetNamespaceId: d.targetNamespaceId ?? null,
        valueSizeDelta: d.valueSizeDelta,
        valueSize: d.valueSize,
        value: text.clean(d.value, 2048),
      };
    }
    case 0x4150:
    case 0x4250:
    case 0x4350: {
      const d = parse(accountRestriction);
      if (!d) return otherDetails(tx, text);
      const flags = d.restrictionFlags;
      const restrictionType =
        (flags & 0x0004) !== 0
          ? 'transactionType'
          : (flags & 0x0002) !== 0
            ? 'mosaicId'
            : 'address';
      return {
        kind: 'accountRestriction',
        restrictionType,
        direction: (flags & 0x4000) !== 0 ? 'outgoing' : 'incoming',
        mode: (flags & 0x8000) !== 0 ? 'block' : 'allow',
        restrictionFlags: flags,
        restrictionAdditions: d.restrictionAdditions.map(restrictionItem),
        restrictionDeletions: d.restrictionDeletions.map(restrictionItem),
      };
    }
    case 0x4251: {
      const d = parse(mosaicAddressRestriction);
      return d ? { kind: 'mosaicAddressRestriction', ...d } : otherDetails(tx, text);
    }
    case 0x4151: {
      const d = parse(mosaicGlobalRestriction);
      return d ? { kind: 'mosaicGlobalRestriction', ...d } : otherDetails(tx, text);
    }
    default:
      return otherDetails(tx, text);
  }
}
