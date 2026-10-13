/**
 * Keeps the user-facing documents in step with the code: every registered tool and every
 * environment variable is documented in both READMEs, server.json (the MCP Registry entry)
 * declares exactly the variables the server reads, its versions and those of package-lock.json
 * follow package.json, the two READMEs have the same number of `## ` sections, both have the
 * Privacy Policy section right after Security and a heading on the Claude Desktop bundle (.mcpb),
 * no document a user reads names a tool that was
 * removed (test/removed-tools.ts), and the numbers of tools that the READMEs, evals/README.md and
 * docs/DESIGN-BRIEF.md state are those of the code.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_VARS } from '../../src/cli.js';
import { TOOLS } from '../../src/server.js';
import { REMOVED_TOOLS } from '../removed-tools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const READMES = ['README.md', 'README.ja.md'] as const;
/** The other documents that name tools: for contributors, and the three that ship as metadata. */
const OTHER_USER_DOCUMENTS = [
  'CONTRIBUTING.md',
  'SECURITY.md',
  'server.json',
  'mcpb/manifest.json',
] as const;

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

interface RegistryEntry {
  version: string;
  packages: Array<{ version: string; environmentVariables: Array<{ name: string }> }>;
}

interface Lockfile {
  version: string;
  packages: Record<string, { version?: string }>;
}

const serverJson = JSON.parse(read('server.json')) as RegistryEntry;
const packageJson = JSON.parse(read('package.json')) as { version: string };
const packageLock = JSON.parse(read('package-lock.json')) as Lockfile;

/** Headings (any level) outside fenced code blocks. */
function headings(markdown: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence && /^#{1,6} /.test(line)) {
      found.push(line);
    }
  }
  return found;
}

/** `## ` headings outside fenced code blocks. */
function level2Headings(markdown: string): string[] {
  return headings(markdown).filter((line) => line.startsWith('## '));
}

/** Where the number stands in a counted sentence. */
const NUMBER = '{n}';

/** A sentence that states a number, written as the document has it, with `{n}` for the number. */
interface CountedSentence {
  readonly sentence: string;
  readonly expected: number;
}

/**
 * Removes the whitespace. Documents wrap their lines, and a Japanese sentence can break between
 * any two characters, so a sentence is looked for with the whitespace taken out of both the text
 * and the sentence. One space stays between two digits, so that two numbers never join ("1" at
 * the end of a line and "20" on the next are not 120).
 */
function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/(?<!\d) | (?!\d)/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds each sentence in the text, wherever its lines break, and compares the number it states
 * with the expected one. The number is the whole run of digits, compared as written ("120" is not
 * "20"). Returns one line for each occurrence with another number and for each sentence that is
 * not found: a reworded sentence must not pass by matching nothing. Throws when a listed sentence
 * does not contain `{n}` exactly once, or has a digit next to it.
 */
function documentedCountProblems(text: string, sentences: readonly CountedSentence[]): string[] {
  const squeezed = squeeze(text);
  const problems: string[] = [];
  for (const { sentence, expected } of sentences) {
    const parts = squeeze(sentence).split(NUMBER);
    const [before, after] = parts;
    if (
      parts.length !== 2 ||
      before === undefined ||
      after === undefined ||
      /\d$/.test(before) ||
      /^\d/.test(after)
    ) {
      throw new Error(
        `The sentence "${sentence}" must contain ${NUMBER} exactly once, with no digit next to it.`,
      );
    }
    const pattern = new RegExp(`${escapeRegExp(before)}(?<!\\d)(\\d+)${escapeRegExp(after)}`, 'g');
    const found = [...squeezed.matchAll(pattern)].map((match) => match[1]);
    if (found.length === 0) {
      problems.push(`"${sentence}": not found`);
    }
    for (const written of found) {
      if (written !== String(expected)) {
        problems.push(`"${sentence}": says ${written}, expected ${expected}`);
      }
    }
  }
  return problems;
}

const TOTAL = TOOLS.length;
const WITH_UNTRUSTED_TEXT = TOOLS.filter((t) => t.untrustedText === true).length;
const OTHERS = TOTAL - WITH_UNTRUSTED_TEXT;

/**
 * The sentences that state a number of tools, as each document has them. The total is
 * TOOLS.length; the tools that show text written by others are those that set untrustedText; "the
 * other N tools" is the difference. A sentence that is reworded is not found any more, and that
 * fails too: update it here.
 *
 * Not listed, because they count something else: in DESIGN-BRIEF §5, "the 2 tools" and "2 tools"
 * (two named tools); in §7, "the 13 tools `symbol_network_info`, …" (the first part of the
 * breakdown of the tools the live test calls, which TOOLS cannot give) and "(16 of them)" (the
 * arguments that take an identifier). The listed sentences carry enough of their surroundings (a
 * leading "(", the words after the number) to match none of them.
 */
const TOOL_COUNT_SENTENCES: Record<string, readonly CountedSentence[]> = {
  'README.md': [
    { sentence: 'into {n} task-level tools', expected: TOTAL },
    { sentence: 'All {n} tools are read-only', expected: TOTAL },
    { sentence: 'The {n} tools that show such text', expected: WITH_UNTRUSTED_TEXT },
  ],
  'README.ja.md': [
    { sentence: '{n} 個の目的別ツール', expected: TOTAL },
    { sentence: '{n} ツールすべてが読み取り専用', expected: TOTAL },
    { sentence: 'こうした文字列を出す {n} のツールは', expected: WITH_UNTRUSTED_TEXT },
  ],
  'docs/DESIGN-BRIEF.md': [
    { sentence: '{n} tools in total (§5; `TOOLS`', expected: TOTAL },
    { sentence: 'the {n} tools that put third-party strings', expected: WITH_UNTRUSTED_TEXT },
    { sentence: '(the {n} tools `symbol_network_info`', expected: WITH_UNTRUSTED_TEXT },
    { sentence: 'The other {n} tools (`symbol_address_parse`', expected: OTHERS },
    { sentence: 'the output of the {n} tools with `untrustedText`', expected: WITH_UNTRUSTED_TEXT },
    { sentence: 'the other {n} tools have neither', expected: OTHERS },
    {
      sentence: 'the list of tools with `untrustedText` equals the {n} tools',
      expected: WITH_UNTRUSTED_TEXT,
    },
  ],
  'evals/README.md': [{ sentence: 'argument shapes for the {n} tools', expected: TOTAL }],
};

describe('documentation stays in sync with the code', () => {
  for (const file of READMES) {
    it(`${file} names every registered tool`, () => {
      const text = read(file);
      expect(TOOLS.map((t) => t.name).filter((name) => !text.includes(name))).toEqual([]);
    });

    it(`${file} names every environment variable`, () => {
      const text = read(file);
      expect(ENV_VARS.map((v) => v.name).filter((name) => !text.includes(name))).toEqual([]);
    });
  }

  it('server.json declares exactly the environment variables the server reads', () => {
    const declared = serverJson.packages[0]?.environmentVariables.map((v) => v.name) ?? [];
    expect(new Set(declared)).toEqual(new Set(ENV_VARS.map((v) => v.name)));
    expect(declared).toHaveLength(ENV_VARS.length);
  });

  it('server.json versions match package.json', () => {
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages[0]?.version).toBe(packageJson.version);
  });

  it('package-lock.json versions match package.json', () => {
    // The root version and the root package entry (key ""), both written by npm install.
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages['']?.version).toBe(packageJson.version);
  });

  it('README.md and README.ja.md have the same number of sections', () => {
    const en = level2Headings(read('README.md'));
    const ja = level2Headings(read('README.ja.md'));
    expect(en.length).toBeGreaterThan(0);
    expect(ja).toHaveLength(en.length);
  });

  // README.md#privacy-policy is meant to be given as the privacy policy URL where the server is
  // listed, so the English heading must stay as it is, and the section stays where both READMEs
  // have it.
  const PRIVACY_SECTIONS = [
    { file: 'README.md', security: '## Security', privacy: '## Privacy Policy' },
    { file: 'README.ja.md', security: '## セキュリティ', privacy: '## プライバシーポリシー' },
  ] as const;
  for (const { file, security, privacy } of PRIVACY_SECTIONS) {
    it(`${file} has the Privacy Policy section right after Security`, () => {
      const sections = level2Headings(read(file));
      const at = sections.indexOf(security);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(sections[at + 1]).toBe(privacy);
    });
  }

  for (const file of READMES) {
    it(`${file} has a section on the Claude Desktop bundle (.mcpb)`, () => {
      expect(headings(read(file)).some((h) => h.includes('.mcpb'))).toBe(true);
    });
  }

  // A tool that was removed or merged must not be named where users read what the server does.
  // The last three files are protected: a pull request that removes a tool fails here until a
  // human has applied its patch for them, as a release pull request does for the versions above.
  for (const file of [...READMES, ...OTHER_USER_DOCUMENTS]) {
    it(`${file} names no removed tool`, () => {
      const text = read(file);
      expect(REMOVED_TOOLS.filter((name) => text.includes(name))).toEqual([]);
    });
  }

  for (const [file, sentences] of Object.entries(TOOL_COUNT_SENTENCES)) {
    it(`${file} states the numbers of tools the code has`, () => {
      expect(
        documentedCountProblems(read(file), sentences),
        'a number differs from TOOLS, or a listed sentence was reworded (update TOOL_COUNT_SENTENCES)',
      ).toEqual([]);
    });
  }

  // The two counts of DESIGN-BRIEF §7 that are not listed. The second is 16, like the tools with
  // untrustedText: a listed sentence that took it would pass the test of the document unnoticed.
  it('no listed sentence takes another count for a number of tools', () => {
    const others = [
      'The tools called are the 13 tools `symbol_network_info`, `symbol_node_status`',
      'every argument that takes an identifier (16 of them) gives input errors',
    ].join('. ');
    const listed = Object.values(TOOL_COUNT_SENTENCES).flat();
    expect(listed.length).toBeGreaterThan(0);
    expect(documentedCountProblems(others, listed)).toEqual(
      listed.map(({ sentence }) => `"${sentence}": not found`),
    );
  });
});

describe('the check of the numbers a document states', () => {
  const ALL: CountedSentence = { sentence: 'All {n} tools are read-only', expected: 20 };
  const INTO: CountedSentence = { sentence: 'into {n} task-level tools', expected: 20 };
  const ALL_JA: CountedSentence = { sentence: '{n} ツールすべてが読み取り専用', expected: 20 };
  const SHOWN_JA: CountedSentence = {
    sentence: 'こうした文字列を出す {n} のツールは',
    expected: 16,
  };
  const LIST: CountedSentence = {
    sentence: '(the {n} tools `symbol_network_info`',
    expected: 16,
  };

  it('reports nothing when each sentence is there with its number', () => {
    expect(documentedCountProblems('All 20 tools are read-only (`readOnlyHint`).', [ALL])).toEqual(
      [],
    );
    expect(
      documentedCountProblems('こうした文字列を出す 16 のツールは、除去した文字の数を返します。', [
        SHOWN_JA,
      ]),
    ).toEqual([]);
    expect(
      documentedCountProblems(
        'It turns the API into 20 task-level tools. All 20 tools are read-only.',
        [INTO, ALL],
      ),
    ).toEqual([]);
  });

  it('finds an English sentence that is broken across lines', () => {
    // The shape of the opening sentence of README.md: the number ends a line.
    expect(
      documentedCountProblems('turns the Symbol REST API into 20\ntask-level tools. Instead', [
        INTO,
      ]),
    ).toEqual([]);
    expect(documentedCountProblems('Intro. All\n20 tools are read-only.', [ALL])).toEqual([]);
    expect(documentedCountProblems('  All 20 tools\r\n\t  are read-only.', [ALL])).toEqual([]);
  });

  it('finds a Japanese sentence that is broken across lines, also inside a word', () => {
    expect(
      documentedCountProblems(
        '絵文字に分かれます。こうした文字列を出す\n  16 のツールは、除去した',
        [SHOWN_JA],
      ),
    ).toEqual([]);
    expect(
      documentedCountProblems('こうした文字\n  列を出す 16 のツ\n  ールは、', [SHOWN_JA]),
    ).toEqual([]);
    expect(documentedCountProblems('こうした文字列を出す16のツールは、', [SHOWN_JA])).toEqual([]);
    const wide = String.fromCodePoint(0x3000);
    expect(
      documentedCountProblems(`こうした文字列を出す${wide}16${wide}のツールは、`, [SHOWN_JA]),
    ).toEqual([]);
  });

  it('reports a number that differs, as the document writes it', () => {
    expect(documentedCountProblems('All 22 tools are read-only.', [ALL])).toEqual([
      '"All {n} tools are read-only": says 22, expected 20',
    ]);
    // README.md as 0.10.0 shipped it.
    expect(
      documentedCountProblems('turns the Symbol REST API into 22\ntask-level tools.', [INTO]),
    ).toEqual(['"into {n} task-level tools": says 22, expected 20']);
    expect(documentedCountProblems('こうした文字列を出す\n  18 のツールは、', [SHOWN_JA])).toEqual([
      '"こうした文字列を出す {n} のツールは": says 18, expected 16',
    ]);
    expect(documentedCountProblems('All 020 tools are read-only.', [ALL])).toEqual([
      '"All {n} tools are read-only": says 020, expected 20',
    ]);
  });

  it('reports a listed sentence that is not in the text', () => {
    const notFound = ['"All {n} tools are read-only": not found'];
    expect(documentedCountProblems('Every tool is read-only.', [ALL])).toEqual(notFound);
    expect(documentedCountProblems('All of the 20 tools are read-only.', [ALL])).toEqual(notFound);
    expect(documentedCountProblems('All twenty tools are read-only.', [ALL])).toEqual(notFound);
    expect(documentedCountProblems('', [ALL])).toEqual(notFound);
    expect(documentedCountProblems('こうした文字列を出すツールは、', [SHOWN_JA])).toEqual([
      '"こうした文字列を出す {n} のツールは": not found',
    ]);
  });

  it('never joins two numbers when it removes the whitespace', () => {
    expect(
      documentedCountProblems('既定は 1\n20 ツールすべてが読み取り専用です。', [ALL_JA]),
    ).toEqual([]);
    expect(
      documentedCountProblems('既定は 1 20 ツールすべてが読み取り専用です。', [ALL_JA]),
    ).toEqual([]);
    expect(
      documentedCountProblems('up to 1\n20 tools in total', [
        { sentence: '{n} tools in total', expected: 20 },
      ]),
    ).toEqual([]);
    // Also across a run of whitespace: the next line is indented, or the line ends with CRLF.
    expect(
      documentedCountProblems('既定は 1\n  20 ツールすべてが読み取り専用です。', [ALL_JA]),
    ).toEqual([]);
    expect(
      documentedCountProblems('既定は 1\r\n20 ツールすべてが読み取り専用です。', [ALL_JA]),
    ).toEqual([]);
    // A number that is written as one run of digits is read whole, also when it ends the sentence.
    expect(documentedCountProblems('120 ツールすべてが読み取り専用です。', [ALL_JA])).toEqual([
      '"{n} ツールすべてが読み取り専用": says 120, expected 20',
    ]);
    expect(documentedCountProblems('All 205 tools are read-only.', [ALL])).toEqual([
      '"All {n} tools are read-only": says 205, expected 20',
    ]);
    const last: CountedSentence = { sentence: 'there are {n}', expected: 20 };
    expect(documentedCountProblems('there are 20 tools', [last])).toEqual([]);
    expect(documentedCountProblems('there are 205 tools', [last])).toEqual([
      '"there are {n}": says 205, expected 20',
    ]);
  });

  it('checks every occurrence of a sentence, and every sentence in the order given', () => {
    expect(
      documentedCountProblems('All 20 tools are read-only. All 21 tools are read-only.', [ALL]),
    ).toEqual(['"All {n} tools are read-only": says 21, expected 20']);
    expect(documentedCountProblems('All 22 tools are read-only.', [INTO, ALL])).toEqual([
      '"into {n} task-level tools": not found',
      '"All {n} tools are read-only": says 22, expected 20',
    ]);
  });

  it('does not take another count for the sentence', () => {
    // The breakdown of the live test in DESIGN-BRIEF §7 has no "(" before "the".
    const breakdown =
      'The tools called are the 13 tools `symbol_network_info`, `symbol_node_status`';
    expect(documentedCountProblems(breakdown, [LIST])).toEqual([
      '"(the {n} tools `symbol_network_info`": not found',
    ]);
    expect(
      documentedCountProblems(
        `in their output (the 16 tools \`symbol_network_info\`, and more). ${breakdown}`,
        [LIST],
      ),
    ).toEqual([]);
  });

  it('reads the sentence literally and with its case', () => {
    const others: CountedSentence = {
      sentence: 'The other {n} tools (`symbol_address_parse`',
      expected: 4,
    };
    expect(
      documentedCountProblems('The other 4 tools (`symbol_address_parse`, and 3 more)', [others]),
    ).toEqual([]);
    expect(
      documentedCountProblems('the other 4 tools (`symbol_address_parse`, and 3 more)', [others]),
    ).toEqual(['"The other {n} tools (`symbol_address_parse`": not found']);
    // A dot in a sentence is a dot, not "any character".
    expect(
      documentedCountProblems('Allx20 tools are read-only', [
        { sentence: 'All.{n} tools are read-only', expected: 20 },
      ]),
    ).toEqual(['"All.{n} tools are read-only": not found']);
  });

  it('refuses a sentence that does not have {n} exactly once, or has a digit next to it', () => {
    const check = (sentence: string) => () =>
      documentedCountProblems('x', [{ sentence, expected: 20 }]);
    expect(check('All tools are read-only')).toThrow('must contain {n} exactly once');
    expect(check('{n} of {n} tools')).toThrow('must contain {n} exactly once');
    // The space between two digits stays in the text, so such a sentence could never be found.
    expect(check('version 5 {n} tools')).toThrow('no digit next to it');
    expect(check('{n} 3 tools')).toThrow('no digit next to it');
  });
});
