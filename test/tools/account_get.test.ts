import { afterEach, describe, expect, it, vi } from 'vitest';
import { base32AddressToHex, publicKeyToAddress } from '../../src/domain/address.js';
import {
  fixture,
  H,
  jsonResponse,
  mainnetRoutes,
  resourceNotFound,
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
// Cosignatories of the synthetic multisig fixtures (test/fixtures/README.md).
const COSIGNATORY_1_PUBLIC_KEY = H('fixture:cosignatory-1');
const [COSIGNATORY_1, COSIGNATORY_2, COSIGNATORY_3] = [1, 2, 3].map((n) =>
  publicKeyToAddress(H(`fixture:cosignatory-${n}`), 104),
) as [string, string, string];
const COSIGNATORY_1_HEX = base32AddressToHex(COSIGNATORY_1);
const COSIGNATORY_2_HEX = base32AddressToHex(COSIGNATORY_2);
const COSIGNATORY_3_HEX = base32AddressToHex(COSIGNATORY_3);

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

  // Whether delegated harvesting works is symbol_delegation_diagnose's question (tool routing);
  // symbol_harvesting_status only lists what the configured node has unlocked.
  it('points to symbol_delegation_diagnose in the delegated harvesting note', async () => {
    server = await startTestServer();
    const configured = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(configured.structuredContent?.delegatedHarvesting).toEqual({
      configured: true,
      note: 'The linked and VRF keys are both set. Whether delegated harvesting actually works (node key, the unlocked list of the node, balance limits, importance, recent blocks) is checked by symbol_delegation_diagnose.',
    });
    await server.close();
    server = undefined;

    const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    account.account.supplementalPublicKeys = {};
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account },
    });
    const bare = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(bare.structuredContent?.delegatedHarvesting).toEqual({
      configured: false,
      note: 'Delegated harvesting needs both a linked (remote) key and a VRF key; symbol_delegation_diagnose shows which step is missing.',
    });
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
    // Lower-case words are namespace names now; these fail every rule.
    for (const bad of ['Hello!', 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYU', 'A'.repeat(40)]) {
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
    const looksLikeSecret = 'DEADBEEF'.repeat(8); // 64 hex, unknown on the fake node -> 404
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /accounts/${looksLikeSecret}`]: resourceNotFound(looksLikeSecret),
      },
    });
    const result = await server.callTool('symbol_account_get', { account: looksLikeSecret });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No account with public key DEADBEEF… exists on mainnet/);
    expect(result.text).not.toContain(looksLikeSecret);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain(looksLikeSecret);
  });

  // catapult-rest serves GET /account/{address}/multisig (singular). A node answers the plural
  // form ("accounts") of that route with a 404 too, so the wrong path used to read as "not a
  // multisig account" for every account.
  it('reports a multisig account from GET /account/{address}/multisig', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /account/${ADDRESS}/multisig`]: fixture('mainnet/multisig-account.json'),
      },
    });
    const result = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.multisig).toEqual({
      minApproval: 2,
      minRemoval: 2,
      cosignatoryAddresses: [COSIGNATORY_1, COSIGNATORY_2, COSIGNATORY_3],
      multisigAddresses: [],
    });
    const summary = String(result.structuredContent?.summary);
    expect(summary).toMatch(/; multisig 2-of-3\.$/m);
    expect(summary).not.toMatch(/cosignatory of/);
    expect(server.requests.some((u) => u.pathname === `/account/${ADDRESS}/multisig`)).toBe(true);
  });

  it('reports a cosignatory without calling it a multisig account', async () => {
    const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    account.account.address = COSIGNATORY_1_HEX;
    account.account.publicKey = COSIGNATORY_1_PUBLIC_KEY;
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /accounts/${COSIGNATORY_1}`]: account,
        [`GET /account/${COSIGNATORY_1}/multisig`]: fixture('mainnet/multisig-cosignatory.json'),
      },
    });
    const result = await server.callTool('symbol_account_get', { account: COSIGNATORY_1 });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.multisig).toEqual({
      minApproval: 0,
      minRemoval: 0,
      cosignatoryAddresses: [],
      multisigAddresses: [ADDRESS],
    });
    const summary = String(result.structuredContent?.summary);
    expect(summary).toMatch(
      /; cosignatory of 1 multisig account \(not a multisig account itself\)\.$/m,
    );
    expect(summary).not.toMatch(/-of-/);
  });

  it('reports both roles of an account in a multilevel multisig', async () => {
    const both = fixture<{ multisig: Record<string, unknown> }>('mainnet/multisig-account.json');
    both.multisig.multisigAddresses = [COSIGNATORY_3_HEX, COSIGNATORY_2_HEX];
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /account/${ADDRESS}/multisig`]: both },
    });
    const result = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(result.structuredContent?.summary).toMatch(
      /; multisig 2-of-3; cosignatory of 2 multisig accounts\.$/m,
    );
  });

  it('reads the 404 of the multisig route as no multisig entry', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /account/${ADDRESS}/multisig`]: resourceNotFound(ADDRESS),
      },
    });
    const result = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.multisig).toBeNull();
    expect(result.structuredContent?.summary).toMatch(/; not a multisig account\.$/m);
    expect(server.requests.some((u) => u.pathname === `/account/${ADDRESS}/multisig`)).toBe(true);
  });

  // The 0.9.0 bug: a node without the route answered 404 and the tool said "not a multisig
  // account". A missing route is now an error the caller sees.
  it('is an error, not "not a multisig account", when the node has no multisig route', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /account/${ADDRESS}/multisig`]: () =>
          jsonResponse(
            { code: 'ResourceNotFound', message: `/account/${ADDRESS}/multisig does not exist` },
            404,
          ),
      },
    });
    const result = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Node ${TEST_NODE_HOST} does not provide the endpoint /account/${ADDRESS}/multisig (no such route), so this answer could not be completed. This is likely a bug in symbol-mcp-server, or the node runs a catapult-rest version without this endpoint; try another node, and report it with the tool name if it persists.`,
    );
    expect(result.text).not.toMatch(/not a multisig account|does not exist/);
  });

  it('truncates mosaics in concise mode and returns all in detailed mode', async () => {
    const account = fixture<{ account: { mosaics: Array<{ id: string; amount: string }> } }>(
      'mainnet/account-voting.json',
    );
    account.account.mosaics = Array.from({ length: 12 }, (_, i) => ({
      id: `${i.toString(16).padStart(2, '0').toUpperCase()}ED913FA20223F8`.slice(-16),
      amount: String(1000 + i),
    }));
    // The node knows none of these mosaics (their divisibility stays null).
    const unknownMosaics = Object.fromEntries(
      account.account.mosaics.map((m) => [`GET /mosaics/${m.id}`, resourceNotFound(m.id)]),
    );
    server = await startTestServer({
      routes: { ...mainnetRoutes(), ...unknownMosaics, [`GET /accounts/${ADDRESS}`]: account },
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
