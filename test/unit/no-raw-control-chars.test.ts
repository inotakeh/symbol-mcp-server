/**
 * Source and test files must not contain raw control or bidi/zero-width characters: git treats a
 * file with a NUL byte as binary (unreadable diffs) and bidi overrides can disguise code. Write
 * such characters as JavaScript escape sequences (backslash u XXXX) instead.
 *
 * The forbidden set is built from numeric ranges so that this file itself contains none of them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['src', 'test', 'scripts'];
const TEXT_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml'];

/** [from, to] inclusive code-point ranges that must not appear raw. */
const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // C0 controls except TAB (0x09), LF (0x0a), CR (0x0d)
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f], // DEL
  [0x80, 0x9f], // C1 controls
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x2028, 0x202e], // line/paragraph separators, bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isForbidden(codePoint: number): boolean {
  return FORBIDDEN_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

function listFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else if (TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function findOffenders(text: string): string[] {
  const offenders: string[] = [];
  let line = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\n') {
      line++;
      continue;
    }
    if (isForbidden(cp)) {
      offenders.push(`line ${line}: U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return offenders;
}

describe('no raw control characters in source or test files', () => {
  const files = SCAN_DIRS.flatMap((d) => listFiles(join(ROOT, d)));

  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('detects a NUL and a bidi override in sample text', () => {
    expect(findOffenders(`ok\n${String.fromCodePoint(0)}x${String.fromCodePoint(0x202e)}`)).toEqual(
      ['line 2: U+0000', 'line 2: U+202E'],
    );
    expect(findOffenders('plain\ttext\r\n')).toEqual([]);
  });

  for (const file of files) {
    it(relative(ROOT, file), () => {
      expect(findOffenders(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});
