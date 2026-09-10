import { describe, expect, it } from 'vitest';
import {
  parseTransactionType,
  TRANSACTION_TYPES,
  transactionTypeName,
} from '../../src/domain/txtype.js';

describe('transaction types (catbuffer transaction_type.cats)', () => {
  it('maps the codes the design brief lists', () => {
    expect(transactionTypeName(16724)).toBe('Transfer');
    expect(transactionTypeName(0x4141)).toBe('AggregateComplete');
    expect(transactionTypeName(0x4241)).toBe('AggregateBonded');
    expect(transactionTypeName(0x4143)).toBe('VotingKeyLink');
    expect(transactionTypeName(0x414c)).toBe('AccountKeyLink');
    expect(transactionTypeName(0x4243)).toBe('VrfKeyLink');
    expect(transactionTypeName(0x424c)).toBe('NodeKeyLink');
    expect(transactionTypeName(0x414d)).toBe('MosaicDefinition');
    expect(transactionTypeName(0x424d)).toBe('MosaicSupplyChange');
    expect(transactionTypeName(0x434d)).toBe('MosaicSupplyRevocation');
    expect(transactionTypeName(0x414e)).toBe('NamespaceRegistration');
    expect(transactionTypeName(0x424e)).toBe('AddressAlias');
    expect(transactionTypeName(0x434e)).toBe('MosaicAlias');
    expect(transactionTypeName(0x4148)).toBe('HashLock');
    expect(transactionTypeName(0x4152)).toBe('SecretLock');
    expect(transactionTypeName(0x4252)).toBe('SecretProof');
  });
  it('has 25 distinct entries', () => {
    expect(TRANSACTION_TYPES.size).toBe(25);
    expect(new Set(TRANSACTION_TYPES.values()).size).toBe(25);
  });
  it('labels unknown codes', () => {
    expect(transactionTypeName(0x9999)).toBe('Unknown(0x9999)');
  });
});

describe('parseTransactionType', () => {
  it('accepts names in any casing and spelling', () => {
    expect(parseTransactionType('transfer')).toEqual({ code: 16724, name: 'Transfer' });
    expect(parseTransactionType('VOTING_KEY_LINK')?.code).toBe(0x4143);
    expect(parseTransactionType('Aggregate Complete')?.code).toBe(0x4141);
    expect(parseTransactionType('aggregate-bonded')?.code).toBe(0x4241);
  });
  it('accepts decimal and hex codes', () => {
    expect(parseTransactionType('16724')?.name).toBe('Transfer');
    expect(parseTransactionType('0x4154')?.name).toBe('Transfer');
    expect(parseTransactionType(' 16707 ')?.name).toBe('VotingKeyLink');
  });
  it('rejects garbage', () => {
    expect(parseTransactionType('')).toBeUndefined();
    expect(parseTransactionType('teleport')).toBeUndefined();
    expect(parseTransactionType('999999')).toBeUndefined();
  });
});
