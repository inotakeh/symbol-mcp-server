import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fixture,
  mainnetRoutes,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const HEX_ADDRESS = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';
const PUBLIC_KEY = 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E';

describe('symbol_account_get', () => {
  it('returns balances with aliases, supplemental keys and harvesting status', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      address: { base32: ADDRESS, hex: HEX_ADDRESS },
      publicKey: PUBLIC_KEY,
      accountType: { code: 1, name: 'Main' },
      mosaics: [
        {
          id: '6BED913FA20223F8',
          alias: 'symbol.xym',
          amount: '4321000.000000',
          rawAmount: '4321000000000',
          divisibility: 6,
        },
        {
          id: '66BAE04E8758599E',
          alias: null,
          amount: '1000000000',
          rawAmount: '1000000000',
          divisibility: 0,
        },
      ],
      mosaicCount: 2,
      truncated: false,
      importance: { raw: '6543210987654', height: 5_763_600 },
      supplementalPublicKeys: {
        linked: '54E48E0C3625F1AC6DE5A8B2CD495D1DA3140745FD28145C9BCDE4FDA16F992B',
        node: 'CEF91B106670BC3FDD3614D8B9E816DAA3286817F79A99F902BDC9CD73EF3568',
        vrf: '0D54BCD78C7E1544B9AA606B2501FAC97ECF2D6729856284444D61161E415316',
        voting: [
          { startEpoch: 3340, endEpoch: 3699 },
          { startEpoch: 3700, endEpoch: 4059 },
        ],
      },
      delegatedHarvesting: { configured: true },
      multisig: null,
    });
    expect(result.structuredContent?.heights).toBeUndefined();
    expect(result.structuredContent?.summary).toMatch(/4321000\.000000 symbol\.xym/);
    expect(result.structuredContent?.summary).toMatch(/not a multisig account/);
  });

  it('accepts hex addresses and public keys and hits the configured node only', async () => {
    server = await startTestServer();
    const byHex = await server.callTool('symbol_account_get', { account: HEX_ADDRESS });
    expect(byHex.isError).toBe(false);
    const byKey = await server.callTool('symbol_account_get', {
      account: PUBLIC_KEY.toLowerCase(),
      format: 'detailed',
    });
    expect(byKey.isError).toBe(false);
    expect(byKey.structuredContent?.heights).toEqual({
      addressHeight: 210000,
      publicKeyHeight: 210007,
    });
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    expect(server.requests.some((u) => u.pathname === `/accounts/${ADDRESS}`)).toBe(true);
    expect(server.requests.some((u) => u.pathname === `/accounts/${PUBLIC_KEY}`)).toBe(true);
  });

  it('rejects malformed identifiers with a hint', async () => {
    server = await startTestServer();
    for (const bad of ['hello', 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYU', '0'.repeat(40)]) {
      const result = await server.callTool('symbol_account_get', { account: bad });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/not a valid Symbol account identifier/);
      expect(result.text).toMatch(/39-character base32/);
      expect(result.text).toMatch(/64-character hex public key/);
    }
    expect(server.requests.filter((u) => u.pathname.startsWith('/accounts/'))).toHaveLength(0);
  });

  it('rejects empty input through the input schema', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_account_get', { account: '' });
    expect(result.isError).toBe(true);
  });

  it('treats a 64-hex value as a public key only: no logging, no third-party requests, masked in errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startTestServer();
    const looksLikeSecret = 'DEADBEEF'.repeat(8); // 64 hex, unknown on the fake node -> 404
    const result = await server.callTool('symbol_account_get', { account: looksLikeSecret });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No account with public key DEADBEEF… exists on mainnet/);
    expect(result.text).not.toContain(looksLikeSecret);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain(looksLikeSecret);
  });

  it('reports multisig settings when present', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /accounts/${ADDRESS}/multisig`]: {
          multisig: {
            version: 1,
            accountAddress: HEX_ADDRESS,
            minApproval: 2,
            minRemoval: 1,
            cosignatoryAddresses: [
              '6816B9E6B5FCC12A8E09C5B5D8C4D4A5F1F2C3D4E5F60718',
              '68AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00',
            ],
            multisigAddresses: [],
          },
        },
      },
    });
    const result = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const multisig = result.structuredContent?.multisig as {
      minApproval: number;
      cosignatoryAddresses: string[];
    };
    expect(multisig.minApproval).toBe(2);
    expect(multisig.cosignatoryAddresses).toHaveLength(2);
    expect(multisig.cosignatoryAddresses[0]).toMatch(/^N[A-Z2-7]{38}$/);
    expect(result.structuredContent?.summary).toMatch(/multisig 2-of-2/);
  });

  it('truncates mosaics in concise mode and returns all in detailed mode', async () => {
    const account = fixture<{ account: { mosaics: Array<{ id: string; amount: string }> } }>(
      'mainnet/account-voting.json',
    );
    account.account.mosaics = Array.from({ length: 12 }, (_, i) => ({
      id: `${i.toString(16).padStart(2, '0').toUpperCase()}ED913FA20223F8`.slice(-16),
      amount: String(1000 + i),
    }));
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account },
    });
    const concise = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(concise.structuredContent?.truncated).toBe(true);
    expect(concise.structuredContent?.mosaics).toHaveLength(10);
    expect(concise.structuredContent?.mosaicCount).toBe(12);
    expect(concise.structuredContent?.summary).toMatch(/format=detailed/);
    const detailed = await server.callTool('symbol_account_get', {
      account: ADDRESS,
      format: 'detailed',
    });
    expect(detailed.structuredContent?.truncated).toBe(false);
    expect(detailed.structuredContent?.mosaics).toHaveLength(12);
  });
});
