/**
 * A check that no output carries a character the untrusted-text filter removes or turns into a
 * space (src/domain/sanitize.ts): control characters (tabs and line breaks included), format
 * characters, lone surrogates, line and paragraph separators and the tag block. It walks a value
 * recursively, object keys included, so a tool that later puts node text somewhere new is still
 * covered.
 *
 * Our own multi-line fields (`summary`, `csv`) and the plain text of the CLI legitimately separate
 * their lines with LF. There LF is allowed between lines, and a poisoned input shows a leaked line
 * break instead: the poison puts every line break right before a marker word, so a line that
 * starts with the marker is a line break that got through.
 */
import { expect } from 'vitest';
import type { ToolCallResult } from './harness.js';

/** Everything the filter removes or turns into a space; LF is handled by the caller. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/u;
/** Fields whose value is several lines of our own text joined with LF. */
const MULTI_LINE_FIELDS = new Set(['summary', 'csv']);

function describeChar(text: string): string {
  const found = UNSAFE.exec(text)?.[0] ?? '';
  const codePoint = found.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Problems in one string: one line, or several lines joined with LF when `multiLine`. */
function checkString(text: string, path: string, multiLine: boolean, marker: string | null) {
  const problems: string[] = [];
  const lines = multiLine ? text.split('\n') : [text];
  lines.forEach((line, index) => {
    const where = multiLine ? `${path} line ${index + 1}` : path;
    if (UNSAFE.test(line)) problems.push(`${where}: ${describeChar(line)}`);
    if (marker !== null && multiLine && index > 0 && line.startsWith(marker)) {
      problems.push(`${where}: a line break of untrusted text starts this line`);
    }
  });
  return problems;
}

/**
 * Every unsafe character left anywhere in `value`, as "path: problem" strings (empty when clean).
 * `marker` is the word the poisoned inputs put after each of their line breaks; pass null when the
 * value comes from clean inputs.
 */
export function unsafeTextIn(
  value: unknown,
  marker: string | null = null,
  path = '$',
  multiLine = false,
): string[] {
  if (typeof value === 'string') return checkString(value, path, multiLine, marker);
  if (Array.isArray(value)) {
    return value.flatMap((inner, i) => unsafeTextIn(inner, marker, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [
      ...checkString(key, `${path} key ${JSON.stringify(key)}`, false, null),
      ...unsafeTextIn(inner, marker, `${path}.${key}`, MULTI_LINE_FIELDS.has(key)),
    ]);
  }
  return [];
}

/** Plain text of several lines (the CLI report, a CSV body): LF only between lines. */
export function unsafeLinesIn(text: string, marker: string | null = null): string[] {
  return checkString(text, '$', true, marker);
}

/**
 * Checks both halves of a tool result: structuredContent, and the text block. The text block is
 * JSON (parsed and walked like structuredContent; its raw form may hold only the LF and spaces of
 * the pretty print) or, for a CSV answer, plain lines.
 */
export function expectCleanToolResult(result: ToolCallResult, marker: string | null = null): void {
  expect(unsafeTextIn(result.structuredContent ?? null, marker)).toEqual([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    expect(unsafeLinesIn(result.text, marker)).toEqual([]);
    return;
  }
  expect(unsafeTextIn(parsed, marker)).toEqual([]);
  expect(unsafeLinesIn(result.text)).toEqual([]);
}
