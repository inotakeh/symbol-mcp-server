/**
 * Strings that live on-chain or come from nodes (transfer messages, metadata values, namespace and
 * alias names, friendlyName, host, status codes and version strings) are written by third parties
 * and must be treated as untrusted data (DESIGN-BRIEF §2-8). Before they reach any output we remove
 * the characters that change how text is displayed or read without being visible, and cap the
 * length.
 */

/**
 * Removed from untrusted text:
 * - Cc, every control character: C0 (TAB, LF and CR included), DEL and C1. Terminal escape
 *   sequences lose their ESC / CSI introducer.
 * - Cf, every format character: zero-width space and joiners, bidi marks, embeddings, overrides
 *   and isolates, soft hyphen, word joiner, invisible operators, BOM, interlinear annotation, …
 * - Zl and Zp, LINE SEPARATOR and PARAGRAPH SEPARATOR: not Cc or Cf, but they break lines.
 * - Cs, lone surrogates. With the u flag a well-formed pair is one astral code point and never
 *   matches, so only halves that cannot be encoded as UTF-8 are removed.
 * - The whole tag block U+E0000..U+E007F, unassigned code points included. Tag characters are
 *   invisible to people but readable to language models, which makes them a channel for hidden
 *   instructions ("ASCII smuggling").
 * Variation selectors (U+FE00..U+FE0F, U+E0100..U+E01EF, category Mn) are kept: emoji and
 * ideograph variants need them. Removing Cf also removes ZERO WIDTH JOINER, so emoji ZWJ sequences
 * fall apart into their component emoji; that is intended.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/gu;

export const DEFAULT_MAX_UNTRUSTED_LENGTH = 256;

/** `value` without the characters listed above; nothing else is changed and nothing is cut. */
export function stripUnsafeCharacters(value: string): string {
  return value.replace(UNSAFE_CHARS, '');
}

/**
 * The first `maxLength` UTF-16 code units of `text` followed by "…", or `text` itself when it is
 * not longer. Never cuts between the two halves of a surrogate pair, so well-formed text stays
 * well-formed.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = Math.max(0, Math.floor(maxLength));
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Tabs and line breaks of every kind, with the whitespace around them. */
const BREAKS = /\s*[\t\n\v\f\r\x85\p{Zl}\p{Zp}]\s*/gu;

/**
 * `text` as one line of plain text for a terminal: tabs and line breaks become one space, so the
 * words on either side stay apart; every other unsafe character is removed; the ends are trimmed.
 */
export function toSingleLine(text: string): string {
  return stripUnsafeCharacters(text.replace(BREAKS, ' ')).trim();
}

/** Untrusted text ready for output: unsafe characters removed first, then capped at maxLength. */
export function sanitizeUntrusted(
  value: string,
  maxLength: number = DEFAULT_MAX_UNTRUSTED_LENGTH,
): string {
  return truncateText(stripUnsafeCharacters(value), maxLength);
}
