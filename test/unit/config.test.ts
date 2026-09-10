import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestClient } from '../../src/client/rest.js';
import {
  ConfigError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  loadConfig,
  NetworkVerificationError,
  resolveNetwork,
  validateNodeUrl,
} from '../../src/config.js';
import { createFakeFetch, fixture } from '../tools/harness.js';

describe('validateNodeUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(validateNodeUrl('https://node.example:3001/')).toBe('https://node.example:3001');
    expect(validateNodeUrl('  https://example.test:3001  ')).toBe('https://example.test:3001');
  });
  it('allows http only for loopback', () => {
    expect(validateNodeUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(validateNodeUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(() => validateNodeUrl('http://example.test:3000')).toThrow(ConfigError);
  });
  it('rejects other schemes, credentials and query strings', () => {
    expect(() => validateNodeUrl('ftp://example.test')).toThrow(ConfigError);
    expect(() => validateNodeUrl('not a url')).toThrow(ConfigError);
    expect(() => validateNodeUrl('https://user:pw@example.test:3001')).toThrow(ConfigError);
    expect(() => validateNodeUrl('https://example.test:3001/?x=1')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  it('requires SYMBOL_NODE_URL', () => {
    expect(() => loadConfig({})).toThrow(/SYMBOL_NODE_URL is required/);
    expect(() => loadConfig({ SYMBOL_NODE_URL: '  ' })).toThrow(ConfigError);
  });
  it('applies defaults', () => {
    const c = loadConfig({ SYMBOL_NODE_URL: 'https://example.test:3001' });
    expect(c).toEqual({
      nodeUrl: 'https://example.test:3001',
      expectedNetwork: undefined,
      timeZone: undefined,
      referenceNodes: [],
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
  });
  it('parses every option', () => {
    const c = loadConfig({
      SYMBOL_NODE_URL: 'https://example.test:3001',
      SYMBOL_NETWORK: 'MainNet',
      SYMBOL_TIMEZONE: 'Asia/Tokyo',
      SYMBOL_REFERENCE_NODES: ' https://a.test:3001, https://b.test:3001/ ,',
      SYMBOL_REQUEST_TIMEOUT_MS: '2500',
    });
    expect(c.expectedNetwork).toBe('mainnet');
    expect(c.timeZone).toBe('Asia/Tokyo');
    expect(c.referenceNodes).toEqual(['https://a.test:3001', 'https://b.test:3001']);
    expect(c.requestTimeoutMs).toBe(2500);
  });
  it('rejects invalid option values', () => {
    const base = { SYMBOL_NODE_URL: 'https://example.test:3001' };
    expect(() => loadConfig({ ...base, SYMBOL_NETWORK: 'devnet' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SYMBOL_TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SYMBOL_REQUEST_TIMEOUT_MS: 'fast' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SYMBOL_REQUEST_TIMEOUT_MS: '10' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SYMBOL_REFERENCE_NODES: 'http://evil.test' })).toThrow(
      ConfigError,
    );
  });
});

describe('resolveNetwork', () => {
  afterEach(() => vi.unstubAllGlobals());

  function clientWith(nodeInfo: unknown) {
    const fake = createFakeFetch({ 'GET /node/info': nodeInfo });
    vi.stubGlobal('fetch', fake.fetch);
    return {
      rest: new RestClient({
        baseUrl: 'https://node.test:3001',
        timeoutMs: 1000,
        userAgent: 'test',
      }),
      requests: fake.requests,
    };
  }

  it('detects mainnet from the generation hash seed', async () => {
    const { rest, requests } = clientWith(fixture('mainnet/node-info.json'));
    const net = await resolveNetwork(
      rest,
      loadConfig({ SYMBOL_NODE_URL: 'https://node.test:3001' }),
    );
    expect(net).toEqual({
      name: 'mainnet',
      identifier: 104,
      generationHashSeed: '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6',
      nodeHost: 'mainnet-node.example',
    });
    expect(requests.map((u) => u.host)).toEqual(['node.test:3001']);
  });

  it('fails startup when SYMBOL_NETWORK=mainnet but the node is testnet', async () => {
    const testnetInfo = {
      ...fixture<Record<string, unknown>>('mainnet/node-info.json'),
      networkGenerationHashSeed: '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4',
      networkIdentifier: 152,
    };
    const { rest } = clientWith(testnetInfo);
    const config = loadConfig({
      SYMBOL_NODE_URL: 'https://node.test:3001',
      SYMBOL_NETWORK: 'mainnet',
    });
    await expect(resolveNetwork(rest, config)).rejects.toThrow(NetworkVerificationError);
    await expect(resolveNetwork(rest, config)).rejects.toThrow(/is on testnet/);
  });

  it('fails startup on an unknown network', async () => {
    const unknownInfo = {
      ...fixture<Record<string, unknown>>('mainnet/node-info.json'),
      networkGenerationHashSeed: 'F'.repeat(64),
    };
    const { rest } = clientWith(unknownInfo);
    await expect(
      resolveNetwork(rest, loadConfig({ SYMBOL_NODE_URL: 'https://node.test:3001' })),
    ).rejects.toThrow(/unknown network/);
  });
});
