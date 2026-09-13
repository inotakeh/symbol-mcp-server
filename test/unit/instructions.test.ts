import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../../src/instructions.js';

describe('server instructions', () => {
  it('stays under 150 words', () => {
    const words = SERVER_INSTRUCTIONS.trim().split(/\s+/);
    expect(words.length).toBeGreaterThan(30);
    expect(words.length).toBeLessThanOrEqual(150);
  });

  it('states the read-only contract, the account formats and the tool routing rules', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/read-only/);
    expect(SERVER_INSTRUCTIONS).toMatch(/private key/);
    expect(SERVER_INSTRUCTIONS).toMatch(/39-character base32 address/);
    expect(SERVER_INSTRUCTIONS).toMatch(/64-character hex public key/);
    expect(SERVER_INSTRUCTIONS).toMatch(/symbol_harvesting_income/);
    expect(SERVER_INSTRUCTIONS).toMatch(/symbol_voting_key_status/);
    expect(SERVER_INSTRUCTIONS).toMatch(/symbol_finality_participation/);
    expect(SERVER_INSTRUCTIONS).toMatch(/never recompute/);
  });

  it('is a single line of plain text', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/[\r\n\t]/);
    expect(SERVER_INSTRUCTIONS.startsWith('#')).toBe(false);
  });
});
