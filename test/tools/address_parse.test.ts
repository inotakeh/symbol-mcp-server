import { afterEach, describe, expect, it } from 'vitest';
import { fixture, startTestServer, type TestServer } from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const HEX = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';
const PUBLIC_KEY = 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E';

describe('symbol_address_parse', () => {
  it('parses a base32 address without contacting the node', async () => {
    server = await startTestServer();
    const before = server.requests.length;
    const result = await server.callTool('symbol_address_parse', {
      value: 'ncv5h-rbsfe-gtpnb-iupbv-agwxw-xz43c-4tnoq-uyuy',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      summary: expect.stringMatching(/is a valid mainnet address/),
      valid: true,
      kind: 'address',
      reason: null,
      address: {
        base32: ADDRESS,
        hex: HEX,
        pretty: 'NCV5HR-BSFEGT-PNBIUP-BVAGWX-WXZ43C-4TNOQU-YUY',
      },
      network: { name: 'mainnet', identifier: 104, matchesConfiguredNetwork: true },
      publicKey: null,
      derivedAddresses: null,
      configuredNetwork: 'mainnet',
    });
    expect(server.requests.length).toBe(before);
  });

  it('parses a hex address', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_address_parse', { value: HEX.toLowerCase() });
    expect(result.structuredContent).toMatchObject({
      valid: true,
      kind: 'hexAddress',
      address: { base32: ADDRESS, hex: HEX },
    });
  });

  it('derives addresses from a public key on every known network', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_address_parse', {
      value: PUBLIC_KEY.toLowerCase(),
    });
    expect(result.isError).toBe(false);
    const vectors = fixture<{
      vectors: Array<{ publicKey: string; address_Public: string; address_PublicTest: string }>;
    }>('address-vectors.json');
    expect(result.structuredContent).toMatchObject({
      valid: true,
      kind: 'publicKey',
      publicKey: PUBLIC_KEY,
      address: { base32: ADDRESS, hex: HEX },
      network: { name: 'mainnet', matchesConfiguredNetwork: true },
      derivedAddresses: [
        { network: 'mainnet', identifier: 104, base32: ADDRESS },
        { network: 'testnet', identifier: 152, base32: expect.stringMatching(/^T[A-Z2-7]{38}$/) },
      ],
    });
    const v = vectors.vectors[0];
    const vec = await server.callTool('symbol_address_parse', { value: v?.publicKey ?? '' });
    expect(vec.structuredContent?.derivedAddresses).toEqual([
      { network: 'mainnet', identifier: 104, base32: v?.address_Public },
      { network: 'testnet', identifier: 152, base32: v?.address_PublicTest },
    ]);
  });

  it('flags a testnet address as not matching the configured mainnet node', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_address_parse', {
      value: 'TATNE7Q5BITMUTRRN6IB4I7FLSDRDWZA37JGO5Q',
    });
    expect(result.structuredContent?.network).toEqual({
      name: 'testnet',
      identifier: 152,
      matchesConfiguredNetwork: false,
    });
    expect(result.structuredContent?.summary).toMatch(/configured node is on mainnet/);
  });

  it('returns valid=false with a reason for bad input (not an error result)', async () => {
    server = await startTestServer();
    const cases: Array<[string, RegExp]> = [
      ['NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYVY', /checksum does not match/],
      ['NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYU', /39 characters; got 38/],
      ['ABCDEF', /Hex input must be 48 characters/],
      ['0'.repeat(40), /got 40/],
    ];
    for (const [value, reason] of cases) {
      const result = await server.callTool('symbol_address_parse', { value });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        valid: false,
        kind: 'invalid',
        address: null,
      });
      expect(result.structuredContent?.reason).toMatch(reason);
    }
  });
});
