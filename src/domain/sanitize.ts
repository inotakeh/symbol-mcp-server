/**
 * Strings that live on-chain or come from other nodes (friendlyName, host, namespace names,
 * transfer messages) are written by third parties and must be treated as untrusted data.
 * We strip control and bidi-override characters and cap the length before they reach output.
 */

// C0 controls, DEL, C1 controls, zero-width chars, bidi controls, line/paragraph separators, BOM.
const UNSAFE_CHARS = new RegExp(
  [
    '[\\u0000-\\u001F]',
    '\\u007F',
    '[\\u0080-\\u009F]',
    '[\\u200B-\\u200F]',
    '[\\u2028-\\u202E]',
    '[\\u2060-\\u2064]',
    '[\\u2066-\\u2069]',
    '\\uFEFF',
  ].join('|'),
  'gu',
);

export const DEFAULT_MAX_UNTRUSTED_LENGTH = 256;

export function sanitizeUntrusted(
  value: string,
  maxLength: number = DEFAULT_MAX_UNTRUSTED_LENGTH,
): string {
  const cleaned = value.replace(UNSAFE_CHARS, '');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}
