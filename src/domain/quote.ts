/**
 * How text written by others (DESIGN-BRIEF §2-8) appears inside a summary line.
 *
 * Cleaning (sanitize.ts) leaves one line of visible text, but visible text can still pose as the
 * server's own words: a transfer message that reads `thanks"; fee 0 ...` would close a quote and
 * continue as if the server had written the rest. So every such string is shown after a label,
 * in double quotes, with `"` and `\` escaped as in a JSON string: whatever it contains, it ends
 * where the quote ends. Escaping comes last, after cleaning and any cut to length, so a cut never
 * splits an escape. Only the summary is written this way; the other output fields keep the plain
 * cleaned value.
 */
import { isValidNamespacePath } from './namespace.js';

/** `cleaned` in double quotes, escaped as a JSON string (`"` → `\"`, `\` → `\\`). */
export function quoteUntrusted(cleaned: string): string {
  return JSON.stringify(cleaned);
}

/** `label "value"`: a cleaned third-party string for a summary line. */
export function labelledQuote(label: string, cleaned: string): string {
  return `${label} ${quoteUntrusted(cleaned)}`;
}

/**
 * A mosaic alias or namespace name for a summary line. On chain a name has at most three
 * dot-separated parts of `[a-z0-9][a-z0-9_-]*`, so it has no space or quote and cannot pose as a
 * sentence: such a name stays as it is (`symbol.xym`). A node can return any text, though, and a
 * name outside that grammar is shown as `label "…"`.
 */
export function summaryName(label: string, name: string): string {
  return isValidNamespacePath(name) ? name : labelledQuote(label, name);
}

/**
 * A mosaic as a summary names it: its alias (bare, or `alias "…"` outside the grammar), or its
 * hex id when it has no alias. The id is the server's own text and stays bare.
 */
export function mosaicLabel(alias: string | null | undefined, id: string): string {
  return alias ? summaryName('alias', alias) : id;
}

/** A name where the line already has its label (`alias <name>`): bare, or quoted as above. */
export function quoteName(name: string): string {
  return isValidNamespacePath(name) ? name : quoteUntrusted(name);
}
