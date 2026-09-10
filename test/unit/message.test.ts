import { describe, expect, it } from 'vitest';
import { decodeMessage, MAX_MESSAGE_TEXT_LENGTH } from '../../src/domain/message.js';

const hex = (type: number, text: string) =>
  `${type.toString(16).padStart(2, '0')}${Buffer.from(text, 'utf8').toString('hex')}`;

describe('decodeMessage', () => {
  it('decodes plain UTF-8 text (fixture message from the captured aggregate)', () => {
    const decoded = decodeMessage(
      '00537570706C656D656E7420746F20746865207769746864726177616C20686F742077616C6C6574',
    );
    expect(decoded).toEqual({
      kind: 'plain',
      messageText: 'Supplement to the withdrawal hot wallet',
      sizeBytes: 40,
    });
  });
  it('decodes multibyte text', () => {
    expect(decodeMessage(hex(0, 'こんにちは 🚀')).messageText).toBe('こんにちは 🚀');
  });
  it('reports encrypted messages without a text', () => {
    const decoded = decodeMessage(hex(1, 'ciphertext'));
    expect(decoded.kind).toBe('encrypted');
    expect(decoded.messageText).toBeUndefined();
    expect(decoded.note).toMatch(/cannot be decrypted/);
  });
  it('reports persistent harvesting delegation and unknown types', () => {
    expect(decodeMessage(hex(0xfe, 'x')).kind).toBe('persistentHarvestingDelegation');
    const raw = decodeMessage(hex(0x42, 'x'));
    expect(raw.kind).toBe('raw');
    expect(raw.note).toMatch(/0x42/);
  });
  it('treats absent or empty messages as empty', () => {
    expect(decodeMessage(undefined)).toEqual({ kind: 'empty', sizeBytes: 0 });
    expect(decodeMessage('')).toEqual({ kind: 'empty', sizeBytes: 0 });
  });
  it('strips control and bidi characters from plain text', () => {
    const text = `evil${String.fromCodePoint(0x202e)}text${String.fromCodePoint(0x07)}\n`;
    expect(decodeMessage(hex(0, text)).messageText).toBe('eviltext');
  });
  it('truncates very long text', () => {
    const decoded = decodeMessage(hex(0, 'a'.repeat(MAX_MESSAGE_TEXT_LENGTH + 50)));
    expect(decoded.messageText?.length).toBe(MAX_MESSAGE_TEXT_LENGTH + 1);
    expect(decoded.messageText?.endsWith('…')).toBe(true);
  });
  it('flags invalid hex as raw', () => {
    expect(decodeMessage('zz').kind).toBe('raw');
    expect(decodeMessage('abc').kind).toBe('raw');
  });
});
