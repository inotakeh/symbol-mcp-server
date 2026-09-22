import { afterEach, describe, expect, it } from 'vitest';
import {
  ALIAS_NAMESPACE_ID,
  ALIAS_NAMESPACE_NAME,
  fixture,
  mainnetRoutes,
  type Routes,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const HEX_ADDRESS = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';
const NAMESPACE_PATH = `/namespaces/${ALIAS_NAMESPACE_ID}`;

const EXPECTED_RESOLUTION = {
  input: ALIAS_NAMESPACE_NAME,
  namespace: ALIAS_NAMESPACE_NAME,
  namespaceId: ALIAS_NAMESPACE_ID,
  address: ADDRESS,
};

type NamespaceFixture = {
  meta: { active: boolean };
  namespace: { alias: Record<string, unknown> };
};

function namespaceVariant(mutate: (ns: NamespaceFixture) => void): Routes {
  const ns = fixture<NamespaceFixture>('mainnet/namespace-alias-account.json');
  mutate(ns);
  return { ...mainnetRoutes(), [`GET ${NAMESPACE_PATH}`]: ns };
}

describe('account arguments given as a namespace name', () => {
  it('resolves the alias for symbol_account_get and reports the resolution', async () => {
    server = await startTestServer();
    const byName = await server.callTool('symbol_account_get', { account: ALIAS_NAMESPACE_NAME });
    const byAddress = await server.callTool('symbol_account_get', { account: ADDRESS });
    expect(byName.isError).toBe(false);
    expect(byAddress.isError).toBe(false);
    const named = byName.structuredContent as Record<string, unknown>;
    const direct = byAddress.structuredContent as Record<string, unknown>;
    expect(named.accountResolution).toEqual(EXPECTED_RESOLUTION);
    expect(direct.accountResolution).toBeNull();
    // Same body apart from the resolution and the summary prefix.
    const { accountResolution: _r1, summary: namedSummary, ...namedRest } = named;
    const { accountResolution: _r2, summary: directSummary, ...directRest } = direct;
    expect(namedRest).toEqual(directRest);
    expect(named.address).toEqual({ base32: ADDRESS, hex: HEX_ADDRESS });
    expect((namedSummary as string).split('\n')[0]).toBe(
      `${ALIAS_NAMESPACE_NAME} → ${ADDRESS}. ${(directSummary as string).split('\n')[0]}`,
    );
    expect(server.requests.some((u) => u.pathname === NAMESPACE_PATH)).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('caches the namespace lookup for one block target time', async () => {
    server = await startTestServer();
    await server.callTool('symbol_account_get', { account: ALIAS_NAMESPACE_NAME });
    await server.callTool('symbol_voting_key_status', { account: ALIAS_NAMESPACE_NAME });
    expect(server.requests.filter((u) => u.pathname === NAMESPACE_PATH)).toHaveLength(1);
    // Past the TTL (blockGenerationTargetTime 30 s on the fixture network) it is fetched again.
    const later = new Date(server.ctx.now().getTime() + 31_000);
    await server.close();
    server = await startTestServer({ now: later });
    await server.callTool('symbol_account_get', { account: ALIAS_NAMESPACE_NAME });
    await server.callTool('symbol_account_get', { account: ALIAS_NAMESPACE_NAME });
    expect(server.requests.filter((u) => u.pathname === NAMESPACE_PATH)).toHaveLength(1);
  });

  it('works for every account tool and for the address argument of transaction search', async () => {
    server = await startTestServer();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['symbol_voting_key_status', { account: ALIAS_NAMESPACE_NAME }],
      ['symbol_harvesting_status', { account: ALIAS_NAMESPACE_NAME }],
      [
        'symbol_harvesting_income',
        { account: ALIAS_NAMESPACE_NAME, fromHeight: 5_763_675, toHeight: 5_763_675 },
      ],
      ['symbol_finality_participation', { account: ALIAS_NAMESPACE_NAME, epoch: 4010 }],
      ['symbol_delegation_diagnose', { account: ALIAS_NAMESPACE_NAME }],
      ['symbol_transaction_search', { address: ALIAS_NAMESPACE_NAME }],
      ['symbol_account_rank', { account: ALIAS_NAMESPACE_NAME }],
      ['symbol_holdings_value', { account: ALIAS_NAMESPACE_NAME, unitPrice: '1', currency: 'JPY' }],
    ];
    for (const [name, args] of calls) {
      const result = await server.callTool(name, args);
      expect(result.isError, name).toBe(false);
      expect(result.structuredContent?.accountResolution, name).toEqual(EXPECTED_RESOLUTION);
      expect(result.structuredContent?.summary, name).toMatch(
        new RegExp(`^${ALIAS_NAMESPACE_NAME} → ${ADDRESS}\\. `),
      );
    }
    const noAccount = await server.callTool('symbol_harvesting_status');
    expect(noAccount.structuredContent?.accountResolution).toBeNull();
  });

  it('parses a namespace name with symbol_address_parse (the only branch that uses the node)', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_address_parse', { value: ALIAS_NAMESPACE_NAME });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      valid: true,
      kind: 'namespace',
      address: { base32: ADDRESS, hex: HEX_ADDRESS },
      network: { name: 'mainnet', identifier: 104, matchesConfiguredNetwork: true },
      publicKey: null,
      derivedAddresses: null,
      accountResolution: EXPECTED_RESOLUTION,
    });
    expect(result.structuredContent?.summary).toMatch(
      new RegExp(`^${ALIAS_NAMESPACE_NAME} → ${ADDRESS}\\. Namespace ${ALIAS_NAMESPACE_ID}`),
    );
    expect(server.requests.some((u) => u.pathname === NAMESPACE_PATH)).toBe(true);
    // Plain addresses still never touch the node for a namespace.
    const plain = await server.callTool('symbol_address_parse', { value: ADDRESS });
    expect(plain.structuredContent).toMatchObject({ kind: 'address', accountResolution: null });
  });

  it('explains a namespace without an address alias', async () => {
    server = await startTestServer({
      routes: namespaceVariant((ns) => {
        ns.namespace.alias = { type: 0 };
      }),
    });
    const result = await server.callTool('symbol_account_get', { account: ALIAS_NAMESPACE_NAME });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"fixture-alias" \(935F70F34BFD4E33\) has no alias/);
    expect(result.text).toMatch(/AddressAlias/);
  });

  it('explains a mosaic alias', async () => {
    server = await startTestServer({
      routes: namespaceVariant((ns) => {
        ns.namespace.alias = { type: 1, mosaicId: '6BED913FA20223F8' };
      }),
    });
    const result = await server.callTool('symbol_voting_key_status', {
      account: ALIAS_NAMESPACE_NAME,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/is a mosaic alias for 6BED913FA20223F8, not an address/);
  });

  it('explains a namespace that does not exist', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_account_get', { account: 'no-such-namespace' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Namespace "no-such-namespace" \([0-9A-F]{16}\) does not exist/);
    expect(result.text).toMatch(/never registered, or expired and pruned/);
  });

  it('explains an expired namespace', async () => {
    server = await startTestServer({
      routes: namespaceVariant((ns) => {
        ns.meta.active = false;
      }),
    });
    const result = await server.callTool('symbol_transaction_search', {
      address: ALIAS_NAMESPACE_NAME,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/has expired/);
  });

  it('explains an alias that points at an address without an account', async () => {
    server = await startTestServer({
      routes: namespaceVariant((ns) => {
        // Alias to a different (unrouted) address: the account lookup answers 404.
        ns.namespace.alias = {
          type: 2,
          address: '68258605CB5ABC592FE691190202CDFD6DDEE659A6BB30B8',
        };
      }),
    });
    const result = await server.callTool('symbol_account_get', { account: ALIAS_NAMESPACE_NAME });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/aliases [A-Z2-7]{39}, but no account with that address exists/);
  });

  it('still rejects input that is neither an identifier nor a namespace name', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_account_get', { account: 'Not A Name' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a valid Symbol account identifier/);
    expect(result.text).toMatch(/namespace name such as alice/);
    expect(server.requests.some((u) => /^\/namespaces\/[0-9A-F]{16}$/.test(u.pathname))).toBe(
      false,
    );
  });
});
