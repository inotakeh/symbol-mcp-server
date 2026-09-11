/**
 * Receipt type codes and names.
 *
 * Source: symbol/symbol `catbuffer/schemas/symbol/receipt_type.cats` (enum ReceiptType : uint16),
 * fetched 2026-09-11, cross-checked with symbol-openapi
 * `spec/plugins/receipt/schemas/ReceiptTypeEnum.yml`. Values are the 16-bit codes catapult-rest
 * returns in `receipt.type` (decimal); e.g. 0x2143 = 8515 = HarvestFee.
 */

const TABLE: ReadonlyArray<readonly [number, string]> = [
  [0x124d, 'MosaicRentalFee'],
  [0x134e, 'NamespaceRentalFee'],
  [0x2143, 'HarvestFee'],
  [0x2248, 'LockHashCompleted'],
  [0x2348, 'LockHashExpired'],
  [0x2252, 'LockSecretCompleted'],
  [0x2352, 'LockSecretExpired'],
  [0x3148, 'LockHashCreated'],
  [0x3152, 'LockSecretCreated'],
  [0x414d, 'MosaicExpired'],
  [0x414e, 'NamespaceExpired'],
  [0x424e, 'NamespaceDeleted'],
  [0x5143, 'Inflation'],
  [0xe143, 'TransactionGroup'],
  [0xf143, 'AddressAliasResolution'],
  [0xf243, 'MosaicAliasResolution'],
];

export const RECEIPT_TYPES: ReadonlyMap<number, string> = new Map(TABLE);

const BY_NAME: ReadonlyMap<string, number> = new Map(
  TABLE.map(([code, name]) => [normalizeName(name), code] as const),
);

function normalizeName(name: string): string {
  return name.replace(/[_\s-]/g, '').toLowerCase();
}

export function receiptTypeName(code: number): string {
  return (
    RECEIPT_TYPES.get(code) ?? `Unknown(0x${code.toString(16).toUpperCase().padStart(4, '0')})`
  );
}

/**
 * Code of a receipt type by name ("HarvestFee", "harvest_fee", "Harvest Fee"). Throws for an
 * unknown name: callers pass literals, so a miss is a programming error, not user input.
 */
export function receiptTypeCode(name: string): number {
  const code = BY_NAME.get(normalizeName(name));
  if (code === undefined) throw new Error(`unknown receipt type name: ${name}`);
  return code;
}
