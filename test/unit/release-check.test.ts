/**
 * The release files check: releaseProblems (scripts/release-files.mjs) on synthetic release files,
 * one broken field at a time, and scripts/release-check.mjs as the release workflow runs it on the
 * repository's own files, also when it is started through a symlinked path.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFINITIONS_SNAPSHOT } from '../../scripts/release-definitions.mjs';
import {
  extractSection,
  hasRestartBanner,
  nextMinorVersion,
  parseReleaseVersion,
  previousReleaseVersion,
  RESTART_BANNER,
  type ReleaseFiles,
  releaseProblems,
  versionBump,
} from '../../scripts/release-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release-check.mjs');
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const REPO_CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
/** The release before package.json's version, whose definitions the check compares with. */
const PREVIOUS = previousReleaseVersion(REPO_CHANGELOG, VERSION);
/** The committed definitions snapshot, passed as the previous definitions: no tag is needed. */
const SNAPSHOT = join(ROOT, DEFINITIONS_SNAPSHOT);
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

describe('versions and the restart banner', () => {
  it('takes release versions only: no pre-release, build part or leading zero', () => {
    expect(parseReleaseVersion('0.10.0')).toEqual([0, 10, 0]);
    for (const bad of ['1.0.0-rc.1', '1.0.0+b1', '01.0.0', '1.0', 'v1.0.0', '']) {
      expect(parseReleaseVersion(bad), bad).toBeNull();
    }
  });

  it('finds the release before a version among the dated sections, compared as numbers', () => {
    expect(previousReleaseVersion(CHANGELOG, '1.2.4')).toBe('1.2.3');
    // Found before the section of the new version is written.
    expect(previousReleaseVersion(CHANGELOG, '1.10.0')).toBe('1.2.3');
    expect(previousReleaseVersion(CHANGELOG, '1.2.3')).toBe('1.2.2');
    expect(previousReleaseVersion(CHANGELOG, '1.2.2')).toBeNull();
    // A pre-release heading is not a release; 0.9.10 is after 0.9.2 as a number.
    const withOthers = CHANGELOG.replace(
      '## [Unreleased]',
      '## [Unreleased]\n\n## [1.2.3-rc.1] - 2026-09-20\n\n## [0.9.10] - 2026-08-01',
    );
    expect(previousReleaseVersion(withOthers, '1.0.0')).toBe('0.9.10');
    expect(previousReleaseVersion(REPO_CHANGELOG, '99.0.0')).toBe(VERSION);
  });

  it('names the bump from one version to the next', () => {
    expect(versionBump('0.9.2', '0.9.3')).toBe('patch');
    expect(versionBump('0.9.2', '0.10.0')).toBe('minor');
    expect(versionBump('0.9.2', '1.0.0')).toBe('major');
    for (const next of ['0.9.2', '0.9.1', '0.8.9']) {
      expect(versionBump('0.9.2', next), next).toBe('none');
    }
    expect(nextMinorVersion('0.9.2')).toBe('0.10.0');
    expect(nextMinorVersion('1.4.2')).toBe('1.5.0');
  });

  it('finds the restart banner only at the start of a section', () => {
    // The real notes: 0.9.0 added output fields, 0.9.2 changed text only.
    expect(hasRestartBanner(extractSection(REPO_CHANGELOG, '0.9.0') ?? [])).toBe(true);
    expect(hasRestartBanner(extractSection(REPO_CHANGELOG, '0.9.2') ?? [])).toBe(false);
    expect(hasRestartBanner([RESTART_BANNER])).toBe(true);
    // Wrapped across lines, as the changelog is.
    expect(
      hasRestartBanner([
        '> **After upgrading, restart your MCP host (Claude Desktop, Claude Code',
        '> and others).** This release adds a field.',
      ]),
    ).toBe(true);
    for (const section of [
      ['> No need to restart your MCP host after upgrading.'],
      ['> No MCP host restart is needed after upgrading.'],
      ['### Added', '', RESTART_BANNER],
      ['- After upgrading, restart your MCP host (Claude Desktop, Claude Code and others).'],
      [],
    ]) {
      expect(hasRestartBanner(section), section.join(' / ')).toBe(false);
    }
  });
});

describe('scripts/release-check.mjs', () => {
  it("passes for package.json's version, with or without the tag's v", () => {
    for (const version of [VERSION, `v${VERSION}`]) {
      // The committed snapshot as the previous definitions: the same, and no tag is needed.
      const { status, stdout, stderr } = run(version, '--previous-definitions', SNAPSHOT);
      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe(
        [
          `release-check: definitions compared with ${SNAPSHOT} (--previous-definitions, as ${PREVIOUS}): no change.`,
          `release-check: ${VERSION} in package.json, package-lock.json, server.json and CHANGELOG.md; server.json names symbol-mcp-server (io.github.inotakeh/symbol).`,
          '',
        ].join('\n'),
      );
    }
  });

  it('lists every version field and the missing changelog section for another version', () => {
    const { status, stdout, stderr } = run('0.0.1');
    expect(status).toBe(1);
    expect(stdout).toBe(
      'release-check: definitions not compared: CHANGELOG.md has no release before 0.0.1.\n',
    );
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

  it('exits 2 without exactly one version and at most one --previous-definitions', () => {
    expect(run().status).toBe(2);
    expect(run('').status).toBe(2);
    expect(run(VERSION, VERSION).status).toBe(2);
    expect(run(VERSION, '--previous-definitions').status).toBe(2);
    expect(run(VERSION, '--previous-definitions=').status).toBe(2);
    const twice = [VERSION, '--previous-definitions', SNAPSHOT, '--previous-definitions', SNAPSHOT];
    expect(run(...twice).status).toBe(2);
    expect(run(VERSION, '--other').status).toBe(2);
    expect(run('--previous-definitions', SNAPSHOT).status).toBe(2);
    expect(run(VERSION, `--previous-definitions=${SNAPSHOT}`).status).toBe(0);
  });

  it('refuses a pre-release version', () => {
    const { status, stdout, stderr } = run('1.0.0-rc.1');
    expect(status).toBe(1);
    expect(stdout).toBe(
      'release-check: definitions not compared: 1.0.0-rc.1 is not a release version.\n',
    );
    expect(stderr).toContain(
      'release-check: 1.0.0-rc.1 is not a release version (major.minor.patch, without a pre-release or build part); the release check does not take pre-releases.',
    );
  });

  describe('with --previous-definitions', () => {
    type Snapshot = { tools: Array<{ name: string; description: string }> };
    const current = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;

    /** Runs the check against a previous snapshot made from the current one by `edit`. */
    function againstEdited(edit: (previous: Snapshot) => void) {
      const dir = mkdtempSync(join(tmpdir(), 'release-check-defs-'));
      try {
        const previous = JSON.parse(JSON.stringify(current)) as Snapshot;
        edit(previous);
        const file = join(dir, 'previous.json');
        writeFileSync(file, JSON.stringify(previous));
        return { file, ...run(VERSION, '--previous-definitions', file) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('says when only descriptive text changed, and passes', () => {
      const { file, status, stdout } = againstEdited((previous) => {
        if (previous.tools[0]) previous.tools[0].description = 'An older description.';
      });
      expect(status).toBe(0);
      expect(stdout.split('\n')[0]).toBe(
        `release-check: definitions compared with ${file} (--previous-definitions, as ${PREVIOUS}): descriptive text only, 1 path in ${current.tools[0]?.name}; a patch needs no restart note.`,
      );
    });

    it('reports a shape change, with the prefix on every line', () => {
      const { file, status, stdout, stderr } = againstEdited((previous) => {
        previous.tools.push({ name: 'tool_since_removed', description: 'Gone.' });
      });
      expect(stdout.split('\n')[0]).toMatch(
        /^release-check: definitions compared with .*: the shape changed \(1 change\), so /,
      );
      // Between releases package.json's version is a patch over the previous release; a release
      // PR for a minor version has the banner, so there the check passes.
      if (PREVIOUS !== null && versionBump(PREVIOUS, VERSION) === 'patch') {
        expect(status).toBe(1);
        const lines = stderr.trimEnd().split('\n');
        expect(lines.every((line) => line.startsWith('release-check: '))).toBe(true);
        expect(lines).toContain('release-check:   tool removed: tool_since_removed');
        expect(lines).toContain(`release-check:   ${RESTART_BANNER}`);
        // Compared with a file, so the diff to look at is with that file, not with a tag.
        expect(lines).toContain(`release-check: Full diff: diff ${file} ${DEFINITIONS_SNAPSHOT}`);
      }
    });

    it('fails closed on definitions that are not an object, with the verdict line and no stack', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-check-defs-'));
      try {
        const file = join(dir, 'null.json');
        writeFileSync(file, 'null');
        const { status, stdout, stderr } = run(VERSION, '--previous-definitions', file);
        expect(status).toBe(1);
        expect(stdout).toBe(
          'release-check: definitions not compared: the definitions are not a JSON object.\n',
        );
        expect(stderr).toBe(
          `release-check: the definitions in ${file} (--previous-definitions, as ${PREVIOUS}) are not a JSON object, so they cannot be compared.\n`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails on a file it cannot read', () => {
      const missing = join(ROOT, 'no-such-definitions.json');
      const { status, stdout, stderr } = run(VERSION, '--previous-definitions', missing);
      expect(status).toBe(1);
      expect(stdout).toBe(
        `release-check: definitions not compared: ${missing} could not be read.\n`,
      );
      expect(
        stderr.startsWith(`release-check: cannot read --previous-definitions ${missing}: `),
      ).toBe(true);
    });
  });

  // Node gives a module started through a symlink the URL of the real file, so a main guard that
  // compares that URL with argv would skip the check and exit 0. The scripts must always run.
  it.skipIf(process.platform === 'win32')('checks when started through a symlinked path', () => {
    throughSymlink((linkedRoot) => {
      const checker = join(linkedRoot, 'scripts', 'release-check.mjs');
      expect(runScript(checker, ['0.0.1']).status).toBe(1);
      expect(runScript(checker, [VERSION, '--previous-definitions', SNAPSHOT]).status).toBe(0);

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
