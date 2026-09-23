/**
 * scripts/wait-for-npm.sh, run by bash with stand-ins for npm and sleep at the front of PATH: npm
 * logs its arguments and prints one prepared answer per call (an empty answer means the registry
 * does not show the field yet: nothing on stdout, exit 1, as npm view does), and sleep returns at
 * once. So the loop runs without network or waiting, and each call stands for 15 seconds.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'wait-for-npm.sh');

const FAKE_NPM = [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$FAKE_DIR/calls"',
  'n=$(wc -l < "$FAKE_DIR/calls")',
  'answer=$(sed -n "$((n))p" "$FAKE_DIR/answers")',
  '[ -n "$answer" ] || exit 1',
  'printf "%s\\n" "$answer"',
  '',
].join('\n');
const FAKE_SLEEP = '#!/bin/sh\nexit 0\n';

const SPEC = 'example-server@1.2.3';
const NAME = 'io.github.example/server';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wait(answers: string[], args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wait-for-npm-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'answers'), answers.map((answer) => `${answer}\n`).join(''));
  for (const [file, text] of [
    ['npm', FAKE_NPM],
    ['sleep', FAKE_SLEEP],
  ] as const) {
    writeFileSync(join(dir, file), text);
    chmodSync(join(dir, file), 0o755);
  }
  const base = { ...process.env };
  delete base.NPM_WAIT;
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...base, PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_DIR: dir, ...env },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, 'calls'), 'utf8').trimEnd().split('\n');
  } catch {
    // npm was never called
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

describe.skipIf(process.platform === 'win32')('scripts/wait-for-npm.sh', () => {
  it('prints the value when npm shows it at once, asking only npm view <spec> <field>', () => {
    const result = wait(['https://example.com/attestations'], [SPEC, 'dist.attestations.url']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('https://example.com/attestations\n');
    expect(result.stderr).toBe('');
    expect(result.calls).toEqual([`view ${SPEC} dist.attestations.url`]);
  });

  it('asks again until npm shows the field', () => {
    const result = wait(
      ['', '', 'https://example.com/attestations'],
      [SPEC, 'dist.attestations.url'],
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('https://example.com/attestations\n');
    expect(result.calls).toHaveLength(3);
  });

  it('gives up after NPM_WAIT seconds, asking every 15 seconds', () => {
    const result = wait([], [SPEC, 'dist.attestations.url'], { NPM_WAIT: '30' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `wait-for-npm: npm does not show dist.attestations.url of ${SPEC} after 30s (npm view ${SPEC} dist.attestations.url says why).\n`,
    );
    expect(result.calls).toHaveLength(3);

    expect(wait([], [SPEC, 'mcpName'], { NPM_WAIT: '0' }).calls).toHaveLength(1);
  });

  it('waits 300 seconds when NPM_WAIT is not set', () => {
    const result = wait([], [SPEC, 'mcpName']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('after 300s');
    expect(result.calls).toHaveLength(21);
  });

  it('waits until npm shows the expected value', () => {
    const result = wait(['', NAME], [SPEC, 'mcpName', NAME]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${NAME}\n`);
    expect(result.calls).toEqual([`view ${SPEC} mcpName`, `view ${SPEC} mcpName`]);
  });

  it('fails at once when npm shows another value', () => {
    const result = wait(['io.github.example/other', NAME], [SPEC, 'mcpName', NAME]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `wait-for-npm: npm shows mcpName of ${SPEC} as io.github.example/other, not ${NAME}.\n`,
    );
    expect(result.calls).toHaveLength(1);
  });

  it('exits 2 on a usage error without asking npm', () => {
    for (const args of [
      [],
      [SPEC],
      [SPEC, 'mcpName', NAME, 'extra'],
      ['', 'mcpName'],
      [SPEC, 'mcpName', ''],
    ]) {
      const result = wait([NAME], args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^usage: /);
      expect(result.calls).toEqual([]);
    }
  });

  it('names NPM_WAIT when it is not a whole number of seconds', () => {
    for (const limit of ['soon', '-1', '1.5', '5m']) {
      const result = wait([NAME], [SPEC, 'mcpName'], { NPM_WAIT: limit });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        `wait-for-npm: NPM_WAIT must be a whole number of seconds, not '${limit}'.\n`,
      );
      expect(result.calls).toEqual([]);
    }
  });
});
