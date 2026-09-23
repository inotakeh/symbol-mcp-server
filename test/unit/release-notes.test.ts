/**
 * scripts/release-notes.mjs, run as the release workflow runs it: a child process reading the
 * real CHANGELOG.md. Only released (dated) sections are printed; everything else exits non-zero.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs');

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scripts/release-notes.mjs', () => {
  it('prints the 0.7.0 section without its heading or the next section', () => {
    const { status, stdout } = run('0.7.0');
    expect(status).toBe(0);
    expect(stdout.startsWith('### Added\n')).toBe(true);
    expect(stdout).toContain('`symbol_holdings_value`');
    expect(stdout).toContain('### Changed');
    expect(stdout).not.toContain('## [0.7.0]');
    expect(stdout).not.toContain('## [0.6.0]');
    expect(stdout).not.toContain('`symbol_account_rank`: where an account ranks');
    expect(stdout.endsWith('.\n')).toBe(true);
  });

  it('prints an older section (0.2.0) up to the 0.1.0 heading', () => {
    const { status, stdout } = run('0.2.0');
    expect(status).toBe(0);
    expect(stdout.startsWith('### ')).toBe(true);
    expect(stdout).toContain('`symbol_harvesting_income`');
    expect(stdout).not.toContain('## [');
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.endsWith('\n\n')).toBe(false);
  });

  it('stops the last section (0.1.0) before the link references', () => {
    const { status, stdout } = run('0.1.0');
    expect(status).toBe(0);
    expect(stdout).not.toMatch(/^\[[^\]]+\]: /m);
    expect(stdout).not.toContain('compare/');
  });

  it.each([['9.9.9'], ['Unreleased'], ['[Unreleased]']])('exits 1 for %s', (version) => {
    const { status, stdout, stderr } = run(version);
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/no "## \[.*\] - YYYY-MM-DD" section/);
  });

  it('exits 2 without exactly one argument', () => {
    expect(run().status).toBe(2);
    expect(run('0.7.0', '0.6.0').status).toBe(2);
  });
});
