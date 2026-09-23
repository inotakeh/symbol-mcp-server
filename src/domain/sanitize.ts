/**
 * Strings that live on-chain or come from nodes (transfer messages, metadata values, namespace and
 * alias names, friendlyName, host, status codes and version strings) are written by third parties
 * and must be treated as untrusted data (DESIGN-BRIEF §2-8). Before they reach any output we make
 * them one line (tabs and line breaks become spaces), remove the characters that change how text
 * is displayed or read without being visible, and cap the length.
 */

/**
 * Removed from untrusted text (tabs and line breaks are first turned into spaces, see toSingleLine):
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
 * well-formed, and drops the spaces right before the "…".
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = Math.max(0, Math.floor(maxLength));
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).replace(/ +$/, '')}…`;
}

/** Tabs and line breaks of every kind: TAB, LF, VT, FF, CR, NEL, line and paragraph separator. */
const BREAKS = /[\t\n\v\f\r\x85\p{Zl}\p{Zp}]+/gu;
/** Runs of ordinary spaces. Only U+0020: an ideographic or no-break space is kept as written. */
const SPACE_RUNS = / {2,}/g;
const EDGE_SPACES = /^ +| +$/g;

/** Untrusted text after cleaning, with the number of unsafe characters the cleaning removed. */
export interface CleanedText {
  readonly text: string;
  /**
   * Characters removed: controls, format characters, lone surrogates, tag characters, counted over
   * the whole value (removing comes before the length cap, so this includes any in a part the cap
   * then cut off). Tabs and line breaks that became a space, spaces merged or trimmed, and the
   * characters the cap cut are not counted.
   */
  readonly removed: number;
  /**
   * Where the value comes from, such as the alias of one mosaic or one level of a namespace name:
   * two values with the same key count once per call, even when they were fetched separately.
   */
  readonly key?: string;
  /** For text joined from separately cleaned pieces (a dotted namespace name): those pieces. */
  readonly pieces?: readonly CleanedText[];
}

function cleanLine(value: string): { text: string; removed: number } {
  let removed = 0;
  const text = value
    .replace(BREAKS, ' ')
    .replace(UNSAFE_CHARS, () => {
      removed += 1;
      return '';
    })
    .replace(SPACE_RUNS, ' ')
    .replace(EDGE_SPACES, '');
  return { text, removed };
}

/**
 * `text` as one line of plain text: tabs and line breaks become a space, so the words on either
 * side stay apart; every other unsafe character is removed; runs of spaces become one space; the
 * ends lose their spaces. Other kinds of space (ideographic, no-break) are left as they are.
 */
export function toSingleLine(text: string): string {
  return cleanLine(text).text;
}

/**
 * Untrusted text made one line (toSingleLine) and then capped, with the count of what it lost.
 * `key` names the source (see CleanedText.key) when the value may be fetched more than once.
 */
export function cleanUntrusted(
  value: string,
  maxLength: number = DEFAULT_MAX_UNTRUSTED_LENGTH,
  key?: string,
): CleanedText {
  const { text, removed } = cleanLine(value);
  const cleaned = { text: truncateText(text, maxLength), removed };
  return key === undefined ? cleaned : { ...cleaned, key };
}

/**
 * Untrusted text ready for output: made one line (toSingleLine) first, then capped at maxLength.
 * For text that does not count towards invisibleCharactersRemoved (error messages, logs, the CLI).
 */
export function sanitizeUntrusted(
  value: string,
  maxLength: number = DEFAULT_MAX_UNTRUSTED_LENGTH,
): string {
  return cleanUntrusted(value, maxLength).text;
}

/**
 * `pieces` joined with `separator`, keeping the pieces so that each is counted once per call.
 * When a piece has nothing left after cleaning, the whole has no text either: a dotted name with a
 * missing level cannot be shown, and the caller falls back (useOrNull gives null).
 */
export function joinCleaned(pieces: readonly CleanedText[], separator: string): CleanedText {
  const complete = pieces.every((p) => p.text !== '');
  return {
    text: complete ? pieces.map((p) => p.text).join(separator) : '',
    removed: pieces.reduce((sum, p) => sum + p.removed, 0),
    pieces,
  };
}

/**
 * The untrusted text of one tool call: every piece of text written by others that goes into the
 * output passes through here, and `removed` becomes the output's invisibleCharactersRemoved
 * (DESIGN-BRIEF §2-8). A value cleaned earlier (a cached alias, a name shown twice) is counted once
 * per call, however often it is used: by its key when it has one (two fetches of one source),
 * otherwise by the value itself.
 */
export class UntrustedText {
  #removed = 0;
  readonly #counted = new Set<unknown>();

  /** Unsafe characters removed so far in this call. */
  get removed(): number {
    return this.#removed;
  }

  /** `value` cleaned and capped for output; what was removed is counted. */
  clean(value: string, maxLength: number = DEFAULT_MAX_UNTRUSTED_LENGTH): string {
    return this.use(cleanUntrusted(value, maxLength));
  }

  /** The text of a value cleaned earlier; its removed characters are counted once per call. */
  use(cleaned: CleanedText): string {
    for (const piece of cleaned.pieces ?? [cleaned]) {
      const source = piece.key ?? piece;
      if (this.#counted.has(source)) continue;
      this.#counted.add(source);
      this.#removed += piece.removed;
    }
    return cleaned.text;
  }

  /**
   * `use` for a value that may be absent. Also null when nothing is left after cleaning, so the
   * caller's fallback (a mosaic id, the name the caller typed) applies; what was removed counts.
   */
  useOrNull(cleaned: CleanedText | null | undefined): string | null {
    if (!cleaned) return null;
    const text = this.use(cleaned);
    return text === '' ? null : text;
  }
}
