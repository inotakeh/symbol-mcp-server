import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CliDeps, ENV_VARS, helpText, parseCliArgs, runCli } from '../../src/cli.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, loadConfig } from '../../src/config.js';
import { createFakeFetch, mainnetRoutes, TEST_NOW } from '../tools/harness.js';

describe('parseCliArgs', () => {
  it('serves when there are no arguments (how MCP hosts start the process)', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'serve' });
  });
  it('recognises help and version flags', () => {
    for (const flag of ['--help', '-h', 'help']) {
      expect(parseCliArgs([flag])).toEqual({ mode: 'help' });
    }
    for (const flag of ['--version', '-v', '-V', 'version']) {
      expect(parseCliArgs([flag])).toEqual({ mode: 'version' });
    }
  });
  it('reports anything else as unknown', () => {
    expect(parseCliArgs(['--node-url', 'https://x'])).toEqual({
      mode: 'unknown',
      arg: '--node-url',
    });
    expect(parseCliArgs(['serve'])).toEqual({ mode: 'unknown', arg: 'serve' });
  });
  it('recognises the check subcommand (flags are covered in cli-check.test.ts)', () => {
    expect(parseCliArgs(['check'])).toEqual({
      mode: 'check',
      options: { account: null, warnDays: 14, format: 'text', quiet: false },
    });
    // Only as the first word: the server takes no arguments.
    expect(parseCliArgs(['--quiet', 'check'])).toEqual({ mode: 'unknown', arg: '--quiet' });
  });
});

describe('runCli', () => {
  afterEach(() => vi.unstubAllGlobals());

  function deps() {
    const out: string[] = [];
    const err: string[] = [];
    const serve = vi.fn(async () => {});
    const cliDeps: CliDeps = {
      env: { SYMBOL_NODE_URL: 'https://node.test:3001' },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      serve,
      version: '0.1.0',
      now: () => TEST_NOW,
    };
    return { cliDeps, out, err, serve };
  }

  it('starts the MCP server with no arguments and writes nothing itself', async () => {
    const fake = createFakeFetch(mainnetRoutes());
    vi.stubGlobal('fetch', fake.fetch);
    const { cliDeps, out, err, serve } = deps();
    expect(await runCli([], cliDeps)).toBe(0);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('lets a start-up failure of the server reach the caller', async () => {
    const { cliDeps } = deps();
    const failing = { ...cliDeps, serve: async () => Promise.reject(new Error('no node')) };
    await expect(runCli([], failing)).rejects.toThrow('no node');
  });

  it('runs check without starting the MCP server, and reports on stdout', async () => {
    const fake = createFakeFetch(mainnetRoutes());
    vi.stubGlobal('fetch', fake.fetch);
    const { cliDeps, out, err, serve } = deps();
    expect(await runCli(['check'], cliDeps)).toBe(0);
    expect(serve).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^symbol check: OK \(node\.test:3001, mainnet, /);
    expect(err).toEqual([]);
    expect(new Set(fake.requests.map((u) => u.host))).toEqual(new Set(['node.test:3001']));
  });

  it('does not start the server for a check usage error either (exit code 3)', async () => {
    const { cliDeps, out, serve } = deps();
    expect(await runCli(['check', '--bogus'], cliDeps)).toBe(3);
    expect(serve).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('keeps help, version and unknown arguments on stderr with exit codes 0, 0 and 2', async () => {
    const help = deps();
    expect(await runCli(['--help'], help.cliDeps)).toBe(0);
    expect(help.err).toEqual([helpText('symbol-mcp-server', '0.1.0')]);
    const version = deps();
    expect(await runCli(['--version'], version.cliDeps)).toBe(0);
    expect(version.err).toEqual(['symbol-mcp-server 0.1.0']);
    const unknown = deps();
    expect(await runCli(['--node-url', 'https://x'], unknown.cliDeps)).toBe(2);
    expect(unknown.err[0]).toContain('unknown argument "--node-url"');
    for (const d of [help, version, unknown]) {
      expect(d.out).toEqual([]);
      expect(d.serve).not.toHaveBeenCalled();
    }
  });
});

describe('helpText', () => {
  const text = helpText('symbol-mcp-server', '0.1.0');

  it('names the binary and version', () => {
    expect(text.startsWith('symbol-mcp-server 0.1.0')).toBe(true);
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });

  it('documents the check subcommand, its options and its exit codes', () => {
    expect(text).toContain('symbol-mcp-server check [--account <address|publicKey|namespace>]');
    for (const flag of ['--account', '--warn-days', '--format', '--quiet']) {
      expect(text).toContain(flag);
    }
    expect(text).toContain('(1-120, default 14)');
    expect(text).toMatch(
      /Exit codes: 0 all ok or skipped, 1 warnings, 2 failures,\s+3 could not run/,
    );
    expect(text).toContain('MAILTO');
  });

  it('names no node host: only the <node-host> placeholder and nodewatch', () => {
    // A URL ends before trailing sentence punctuation.
    const urls = new Set(text.match(/https?:\/\/\S*[^\s.,;)]/g) ?? []);
    expect([...urls].sort()).toEqual([
      'https://<node-host>:3001',
      'https://nodewatch.symbol.tools/',
    ]);
  });

  it('documents every environment variable loadConfig reads, marking the required one', () => {
    for (const v of ENV_VARS) expect(text).toContain(v.name);
    expect(text).toMatch(/SYMBOL_NODE_URL\s+\(required\)/);
    expect(text).toContain(`Default ${DEFAULT_REQUEST_TIMEOUT_MS}`);
    // Every documented variable must actually be consumed by loadConfig.
    const env: Record<string, string> = {
      SYMBOL_NODE_URL: 'https://example.test:3001',
      SYMBOL_NETWORK: 'mainnet',
      SYMBOL_TIMEZONE: 'Asia/Tokyo',
      SYMBOL_REFERENCE_NODES: 'https://ref.test:3001',
      SYMBOL_REQUEST_TIMEOUT_MS: '5000',
      SYMBOL_STATE_DIR: '/var/lib/symbol-mcp-server',
    };
    expect(Object.keys(env).sort()).toEqual(ENV_VARS.map((v) => v.name).sort());
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('contains no control characters other than newlines and stays within 100 columns', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is exactly what we check for
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
  });
});
