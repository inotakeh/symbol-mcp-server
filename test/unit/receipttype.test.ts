import { describe, expect, it } from 'vitest';
import { RECEIPT_TYPES, receiptTypeCode, receiptTypeName } from '../../src/domain/receipttype.js';

describe('receipt types (catbuffer receipt_type.cats)', () => {
  it('maps the codes the harvesting tools rely on', () => {
    expect(receiptTypeName(8515)).toBe('HarvestFee');
    expect(receiptTypeName(0x2143)).toBe('HarvestFee');
    expect(receiptTypeName(20803)).toBe('Inflation');
    expect(receiptTypeName(0x124d)).toBe('MosaicRentalFee');
    expect(receiptTypeName(0x134e)).toBe('NamespaceRentalFee');
    expect(receiptTypeName(0xe143)).toBe('TransactionGroup');
  });
  it('resolves names to codes in any casing', () => {
    expect(receiptTypeCode('HarvestFee')).toBe(8515);
    expect(receiptTypeCode('harvest_fee')).toBe(8515);
    expect(receiptTypeCode('Harvest Fee')).toBe(8515);
    expect(receiptTypeCode('Inflation')).toBe(20803);
    expect(() => receiptTypeCode('Bogus')).toThrow(/unknown receipt type/);
  });
  it('has 16 distinct entries', () => {
    expect(RECEIPT_TYPES.size).toBe(16);
    expect(new Set(RECEIPT_TYPES.values()).size).toBe(16);
  });
  it('labels unknown codes', () => {
    expect(receiptTypeName(1)).toBe('Unknown(0x0001)');
  });
});
