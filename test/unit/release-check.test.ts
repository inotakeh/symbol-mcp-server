/**
 * The release files check: releaseProblems (scripts/release-files.mjs) on synthetic release files,
 * one broken field at a time, and scripts/release-check.mjs as the release workflow runs it on the
 * repository's own files, also when it is started through a symlinked path.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractSection,
  type ReleaseFiles,
  releaseProblems,
} from '../../scripts/release-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release-check.mjs');
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const SERVER_PACKAGES = (
  JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8')) as { packages: unknown[] }
).packages;

function run(...args: string[]) {
  return runScript(SCRIPT, args);
}

function runScript(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `use` with the repository reachable through a symlink, then removes the link. */
function throughSymlink<T>(use: (linkedRoot: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
  const link = join(dir, 'repo');
  symlinkSync(ROOT, link, 'dir');
  try {
    return use(link);
  } finally {
    unlinkSync(link);
    rmdirSync(dir);
  }
}

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.2.3] - 2026-09-24',
  '',
  '### Added',
  '',
  '- Something new.',
  '',
  '## [1.2.2] - 2026-09-01',
  '',
  '### Fixed',
  '',
  '- Something old.',
  '',
  '[Unreleased]: https://example.com/compare/v1.2.3...HEAD',
  '',
].join('\n');

/** Release files of 1.2.3 that agree, for the tests to break one field at a time. */
function releaseFiles(): ReleaseFiles {
  return {
    packageJson: { name: 'example-server', version: '1.2.3', mcpName: 'io.github.example/server' },
    packageLock: { version: '1.2.3', packages: { '': { version: '1.2.3' } } },
    serverJson: {
      name: 'io.github.example/server',
      version: '1.2.3',
      packages: [{ registryType: 'npm', identifier: 'example-server', version: '1.2.3' }],
    },
    changelog: CHANGELOG,
  };
}

describe('releaseProblems', () => {
  it('finds nothing when every file agrees', () => {
    expect(releaseProblems('1.2.3', releaseFiles())).toEqual([]);
  });

  it('names each version field that differs', () => {
    const files = releaseFiles();
    files.packageJson.version = '1.2.2';
    expect(releaseProblems('1.2.3', files)).toEqual(['package.json version is 1.2.2, not 1.2.3.']);

    const lock = releaseFiles();
    lock.packageLock = { version: '1.2.2', packages: { '': { version: '1.2.1' } } };
    expect(releaseProblems('1.2.3', lock)).toEqual([
      'package-lock.json version is 1.2.2, not 1.2.3.',
      'package-lock.json packages[""].version is 1.2.1, not 1.2.3.',
    ]);

    const server = releaseFiles();
    server.serverJson = {
      ...server.serverJson,
      version: '1.2.2',
      packages: [{ registryType: 'npm', identifier: 'example-server', version: '1.2.2' }],
    };
    expect(releaseProblems('1.2.3', server)).toEqual([
      'server.json version is 1.2.2, not 1.2.3.',
      'server.json packages[0].version is 1.2.2, not 1.2.3.',
    ]);
  });

  it('reports every problem at once, with missing fields shown as undefined', () => {
    const files = releaseFiles();
    files.packageJson.version = '1.2.2';
    files.packageLock = {};
    files.serverJson = { ...files.serverJson, version: '1.2.2' };
    expect(releaseProblems('1.2.3', files)).toEqual([
      'package.json version is 1.2.2, not 1.2.3.',
      'package-lock.json version is undefined, not 1.2.3.',
      'package-lock.json packages[""].version is undefined, not 1.2.3.',
      'server.json version is 1.2.2, not 1.2.3.',
    ]);
  });

  it('needs server.json name to be package.json mcpName', () => {
    const files = releaseFiles();
    files.serverJson = { ...files.serverJson, name: 'io.github.example/other' };
    expect(releaseProblems('1.2.3', files)).toEqual([
      'server.json name io.github.example/other is not package.json mcpName io.github.example/server; the MCP Registry accepts the npm version only when they are the same.',
    ]);

    const missing = releaseFiles();
    delete missing.packageJson.mcpName;
    expect(releaseProblems('1.2.3', missing)).toEqual([
      'server.json name io.github.example/server is not package.json mcpName undefined; the MCP Registry accepts the npm version only when they are the same.',
    ]);
  });

  it('needs the npm packages of server.json to be this package', () => {
    const files = releaseFiles();
    files.serverJson = {
      ...files.serverJson,
      packages: [{ registryType: 'npm', identifier: 'other-server', version: '1.2.3' }],
    };
    expect(releaseProblems('1.2.3', files)).toEqual([
      'server.json packages[0].identifier is other-server, not package.json name example-server.',
    ]);
  });

  it('checks the version of every package but the identifier of npm packages only', () => {
    const files = releaseFiles();
    files.serverJson = {
      ...files.serverJson,
      packages: [
        { registryType: 'npm', identifier: 'example-server', version: '1.2.3' },
        { registryType: 'mcpb', identifier: 'https://example.com/a.mcpb', version: '1.2.2' },
      ],
    };
    expect(releaseProblems('1.2.3', files)).toEqual([
      'server.json packages[1].version is 1.2.2, not 1.2.3.',
    ]);
  });

  it('needs at least one npm package in server.json', () => {
    const files = releaseFiles();
    files.serverJson = {
      ...files.serverJson,
      packages: [
        { registryType: 'mcpb', identifier: 'https://example.com/a.mcpb', version: '1.2.3' },
      ],
    };
    expect(releaseProblems('1.2.3', files)).toEqual([
      'server.json lists no npm package; it should list example-server.',
    ]);

    const none = releaseFiles();
    delete none.serverJson.packages;
    expect(releaseProblems('1.2.3', none)).toEqual([
      'server.json lists no npm package; it should list example-server.',
    ]);
  });

  it('needs a dated CHANGELOG.md section with notes', () => {
    const files = releaseFiles();
    files.changelog = CHANGELOG.replace('## [1.2.3] - 2026-09-24', '## [1.2.3]');
    expect(releaseProblems('1.2.3', files)).toEqual([
      'CHANGELOG.md has no "## [1.2.3] - YYYY-MM-DD" section.',
    ]);

    const empty = releaseFiles();
    empty.changelog = CHANGELOG.replace('### Added\n\n- Something new.\n\n', '');
    expect(releaseProblems('1.2.3', empty)).toEqual([
      'the CHANGELOG.md section for 1.2.3 is empty.',
    ]);
  });
});

describe('scripts/release-check.mjs', () => {
  it("passes for package.json's version, with or without the tag's v", () => {
    for (const version of [VERSION, `v${VERSION}`]) {
      const { status, stdout, stderr } = run(version);
      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe(
        `release-check: ${VERSION} in package.json, package-lock.json, server.json and CHANGELOG.md; server.json names symbol-mcp-server (io.github.inotakeh/symbol).\n`,
      );
    }
  });

  it('lists every version field and the missing changelog section for another version', () => {
    const { status, stdout, stderr } = run('0.0.1');
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trimEnd().split('\n')).toEqual([
      `release-check: package.json version is ${VERSION}, not 0.0.1.`,
      `release-check: package-lock.json version is ${VERSION}, not 0.0.1.`,
      `release-check: package-lock.json packages[""].version is ${VERSION}, not 0.0.1.`,
      `release-check: server.json version is ${VERSION}, not 0.0.1.`,
      ...SERVER_PACKAGES.map(
        (_, i) => `release-check: server.json packages[${i}].version is ${VERSION}, not 0.0.1.`,
      ),
      'release-check: CHANGELOG.md has no "## [0.0.1] - YYYY-MM-DD" section.',
    ]);
  });

  it('exits 2 without exactly one non-empty argument', () => {
    expect(run().status).toBe(2);
    expect(run('').status).toBe(2);
    expect(run(VERSION, VERSION).status).toBe(2);
  });

  // Node gives a module started through a symlink the URL of the real file, so a main guard that
  // compares that URL with argv would skip the check and exit 0. The scripts must always run.
  it.skipIf(process.platform === 'win32')('checks when started through a symlinked path', () => {
    throughSymlink((linkedRoot) => {
      const checker = join(linkedRoot, 'scripts', 'release-check.mjs');
      expect(runScript(checker, ['0.0.1']).status).toBe(1);
      expect(runScript(checker, [VERSION]).status).toBe(0);

      // The notes are the whole section as CHANGELOG.md has it: a section may start with a notice
      // (a blockquote) before its first "### " heading, so the output is not assumed to start with one.
      const notes = runScript(join(linkedRoot, 'scripts', 'release-notes.mjs'), [VERSION]);
      expect(notes.status).toBe(0);
      const section = extractSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), VERSION);
      expect(section).not.toBeNull();
      expect(section?.length).toBeGreaterThan(0);
      expect(notes.stdout).toBe(`${section?.join('\n')}\n`);
      expect(notes.stdout).toMatch(/^### /m);
    });
  });
});
