/**
 * scripts/wait-for-attestations.sh, run by bash as scripts/wait-for-npm.sh is tested: a stand-in for
 * sleep at the front of PATH returns at once, so each request stands for 15 seconds. The registry
 * is a local HTTP server that answers one prepared status per request (200 with a body, or an
 * error status), so the loop runs without the network or waiting.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'wait-for-attestations.sh');
const FAKE_SLEEP = '#!/bin/sh\nexit 0\n';
const BODY = '{"attestations":[{"predicateType":"https://slsa.dev/provenance/v1"}]}';
const PROXY_VARS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A registry stand-in: the n-th request gets statuses[n] (the last one repeats). */
async function registry(statuses: number[]): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server: Server = createServer((_req, res) => {
    const status = statuses[Math.min(requests, statuses.length - 1)] ?? 404;
    requests += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? BODY : '{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/-/npm/v1/attestations/example-server@1.2.3`,
    requests: () => requests,
  };
}

/** Runs the script (asynchronously, so the local server can answer). */
function wait(args: string[] | ((out: string) => string[]), env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wait-for-attestations-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sleep'), FAKE_SLEEP);
  chmodSync(join(dir, 'sleep'), 0o755);
  const out = join(dir, 'attestations.json');
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.NPM_WAIT;
  for (const name of PROXY_VARS) delete base[name];
  const child = spawn('bash', [SCRIPT, ...(typeof args === 'function' ? args(out) : args)], {
    env: { ...base, PATH: `${dir}:${process.env.PATH ?? ''}`, NO_PROXY: '127.0.0.1', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise<{ status: number | null; stdout: string; stderr: string; out: string }>(
    (resolve) => child.on('close', (status) => resolve({ status, stdout, stderr, out })),
  );
}

describe.skipIf(process.platform === 'win32')('scripts/wait-for-attestations.sh', () => {
  it('saves the attestations when the registry serves them at once', async () => {
    const reg = await registry([200]);
    const result = await wait((out) => [reg.url, out]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(result.out, 'utf8')).toBe(BODY);
    expect(reg.requests()).toBe(1);
  });

  it('asks again while the registry answers 404, then saves them', async () => {
    const reg = await registry([404, 404, 200]);
    const result = await wait((out) => [reg.url, out]);
    expect(result.status).toBe(0);
    expect(readFileSync(result.out, 'utf8')).toBe(BODY);
    expect(reg.requests()).toBe(3);
  });

  it('asks again after a 5xx answer', async () => {
    const reg = await registry([503, 502, 200]);
    const result = await wait((out) => [reg.url, out]);
    expect(result.status).toBe(0);
    expect(reg.requests()).toBe(3);
  });

  it('gives up after NPM_WAIT seconds of 404, asking every 15 seconds', async () => {
    const reg = await registry([404]);
    const result = await wait((out) => [reg.url, out], { NPM_WAIT: '30' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `wait-for-attestations: npm does not serve the attestations at ${reg.url} after 30s (last: HTTP 404).\n`,
    );
    expect(reg.requests()).toBe(3);
    expect(existsSync(result.out)).toBe(false);
  });

  it('waits 300 seconds when NPM_WAIT is not set', async () => {
    const reg = await registry([404]);
    const result = await wait((out) => [reg.url, out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('after 300s');
    expect(reg.requests()).toBe(21);
  });

  it.each([[403], [401], [410]])('fails at once on HTTP %i', async (status) => {
    const reg = await registry([status, 200]);
    const result = await wait((out) => [reg.url, out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `wait-for-attestations: GET ${reg.url} answered HTTP ${status}; waiting will not change that.\n`,
    );
    expect(reg.requests()).toBe(1);
    expect(existsSync(result.out)).toBe(false);
  });

  it('asks again when nothing answers, and names that in the last message', async () => {
    const reg = await registry([200]);
    const closed = reg.url.replace(/:\d+\//, ':1/');
    const result = await wait((out) => [closed, out], { NPM_WAIT: '15' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/after 15s \(last: no answer \(.+\)\)\.\n$/);
    expect(reg.requests()).toBe(0);
  });

  it('exits 2 on a usage error or an NPM_WAIT that is not whole seconds, without a request', async () => {
    const reg = await registry([200]);
    for (const args of [[], [reg.url], ['', 'x'], [reg.url, ''], [reg.url, 'x', 'extra']]) {
      const result = await wait(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^usage: /);
    }
    for (const limit of ['soon', '-1', '1.5']) {
      const result = await wait((out) => [reg.url, out], { NPM_WAIT: limit });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        `wait-for-attestations: NPM_WAIT must be a whole number of seconds, not '${limit}'.\n`,
      );
    }
    expect(reg.requests()).toBe(0);
  });
});
