/**
 * Source and test files must not contain raw control, format or tag characters: git treats a file
 * with a NUL byte as binary (unreadable diffs), bidi overrides can disguise code, and zero-width or
 * tag characters can hide text from a reviewer. Write such characters as escape sequences or build
 * them from code points instead.
 *
 * The forbidden set is the one src/domain/sanitize.ts strips from untrusted text, except TAB, LF and
 * CR. It is written with property escapes, so this file itself contains none of the characters.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['src', 'test', 'scripts'];
const TEXT_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml'];

/** Control (Cc), format (Cf), surrogate (Cs), line and paragraph separator, and the tag block. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/u;
/** TAB, LF and CR are ordinary in source files. */
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

function isForbidden(ch: string): boolean {
  return !ALLOWED_CONTROLS.has(ch.codePointAt(0) ?? 0) && UNSAFE.test(ch);
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
    if (isForbidden(ch)) {
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

  it('detects a soft hyphen, a tag character and a line separator, and allows ordinary text', () => {
    const at = (codePoint: number) => String.fromCodePoint(codePoint);
    expect(findOffenders(`a${at(0xad)}b${at(0xe0041)}c${at(0x2028)}`)).toEqual([
      'line 1: U+00AD',
      'line 1: U+E0041',
      'line 1: U+2028',
    ]);
    expect(findOffenders(`日本語 ${at(0x1f600)} café`)).toEqual([]);
  });

  for (const file of files) {
    it(relative(ROOT, file), () => {
      expect(findOffenders(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});
