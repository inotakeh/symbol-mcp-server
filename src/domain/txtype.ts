/**
 * Transaction type codes and names.
 *
 * Source: symbol/symbol `catbuffer/schemas/symbol/transaction_type.cats` (enum TransactionType :
 * uint16), fetched 2026-09-10. Values are the 16-bit codes catapult-rest returns in
 * `transaction.type` (decimal); e.g. 0x4154 = 16724 = Transfer.
 */

export interface TransactionTypeInfo {
  readonly code: number;
  readonly name: string;
}

const TABLE: ReadonlyArray<readonly [number, string]> = [
  [0x4154, 'Transfer'],
  [0x4141, 'AggregateComplete'],
  [0x4241, 'AggregateBonded'],
  [0x414c, 'AccountKeyLink'],
  [0x424c, 'NodeKeyLink'],
  [0x4143, 'VotingKeyLink'],
  [0x4243, 'VrfKeyLink'],
  [0x4148, 'HashLock'],
  [0x4152, 'SecretLock'],
  [0x4252, 'SecretProof'],
  [0x4144, 'AccountMetadata'],
  [0x4244, 'MosaicMetadata'],
  [0x4344, 'NamespaceMetadata'],
  [0x414d, 'MosaicDefinition'],
  [0x424d, 'MosaicSupplyChange'],
  [0x434d, 'MosaicSupplyRevocation'],
  [0x4155, 'MultisigAccountModification'],
  [0x414e, 'NamespaceRegistration'],
  [0x424e, 'AddressAlias'],
  [0x434e, 'MosaicAlias'],
  [0x4150, 'AccountAddressRestriction'],
  [0x4250, 'AccountMosaicRestriction'],
  [0x4350, 'AccountOperationRestriction'],
  [0x4251, 'MosaicAddressRestriction'],
  [0x4151, 'MosaicGlobalRestriction'],
];

export const TRANSACTION_TYPES: ReadonlyMap<number, string> = new Map(TABLE);

const BY_NAME: ReadonlyMap<string, number> = new Map(
  TABLE.map(([code, name]) => [normalizeName(name), code] as const),
);

function normalizeName(name: string): string {
  return name.replace(/[_\s-]/g, '').toLowerCase();
}

export function transactionTypeName(code: number): string {
  return (
    TRANSACTION_TYPES.get(code) ?? `Unknown(0x${code.toString(16).toUpperCase().padStart(4, '0')})`
  );
}

export function describeTransactionType(code: number): TransactionTypeInfo {
  return { code, name: transactionTypeName(code) };
}

/**
 * Parses a user-supplied type: a name in any casing with optional underscores/spaces
 * ("transfer", "VOTING_KEY_LINK", "Aggregate Complete"), a decimal code ("16724") or a hex code
 * ("0x4154"). Returns undefined when nothing matches.
 */
export function parseTransactionType(value: string): TransactionTypeInfo | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^0x[0-9a-f]{1,4}$/i.test(trimmed)) {
    return describeTransactionType(Number.parseInt(trimmed.slice(2), 16));
  }
  if (/^\d{1,5}$/.test(trimmed)) {
    const code = Number(trimmed);
    return code <= 0xffff ? describeTransactionType(code) : undefined;
  }
  const code = BY_NAME.get(normalizeName(trimmed));
  return code === undefined ? undefined : describeTransactionType(code);
}

/** Names accepted by parseTransactionType, for error messages. */
export function transactionTypeNames(): readonly string[] {
  return TABLE.map(([, name]) => name);
}
