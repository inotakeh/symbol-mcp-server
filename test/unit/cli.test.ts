import { describe, expect, it } from 'vitest';
import { ENV_VARS, helpText, parseCliArgs } from '../../src/cli.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, loadConfig } from '../../src/config.js';

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
});

describe('helpText', () => {
  const text = helpText('symbol-mcp-server', '0.1.0');

  it('names the binary and version', () => {
    expect(text.startsWith('symbol-mcp-server 0.1.0')).toBe(true);
    expect(text).toContain('--help');
    expect(text).toContain('--version');
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
