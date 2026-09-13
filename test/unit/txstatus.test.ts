import { describe, expect, it } from 'vitest';
import {
  describeTransactionStatusCode,
  TRANSACTION_GROUPS,
  TRANSACTION_STATUS_CODES,
} from '../../src/domain/txstatus.js';

describe('transaction status codes (symbol-openapi TransactionStatusEnum)', () => {
  it('carries every enum value in file order', () => {
    expect(TRANSACTION_STATUS_CODES.size).toBe(163);
    const codes = [...TRANSACTION_STATUS_CODES.keys()];
    expect(codes.slice(0, 4)).toEqual([
      'Success',
      'Neutral',
      'Failure',
      'Failure_Core_Past_Deadline',
    ]);
    expect(codes.at(-1)).toBe('Failure_Extension_Read_Rate_Limit_Exceeded');
    expect(codes.every((c) => /^(Success|Neutral|Failure)(_[A-Za-z0-9]+)*$/.test(c))).toBe(true);
  });

  it('explains failure codes with the text of the OpenAPI description', () => {
    expect(describeTransactionStatusCode('Failure_Core_Insufficient_Balance')).toBe(
      'Validation failed because the account has an insufficient balance.',
    );
    expect(describeTransactionStatusCode('Failure_Aggregate_Missing_Cosignatures')).toMatch(
      /required cosignature is missing/,
    );
    expect(describeTransactionStatusCode('Failure_Core_Link_Already_Exists')).toMatch(
      /already linked/,
    );
  });

  it('returns null for codes the enum lists without an explanation and for unknown codes', () => {
    for (const code of ['Success', 'Neutral', 'Failure', 'Failure_Hash_Already_Exists']) {
      expect(TRANSACTION_STATUS_CODES.has(code)).toBe(true);
      expect(describeTransactionStatusCode(code)).toBeNull();
    }
    expect(describeTransactionStatusCode('Failure_Made_Up')).toBeNull();
    expect(describeTransactionStatusCode('')).toBeNull();
  });

  it('lists the four REST transaction groups', () => {
    expect([...TRANSACTION_GROUPS]).toEqual(['confirmed', 'unconfirmed', 'partial', 'failed']);
  });
});
