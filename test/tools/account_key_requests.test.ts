/**
 * A 64-hex account argument is taken as a public key, but it may be a private key pasted by
 * mistake (DESIGN-BRIEF §7: never in logs, output or anything transmitted). Every tool that takes
 * an account, and the CLI check, turns it into its address on this machine and asks the node
 * about the address, so the value is in no request path or query, and no error text can quote it
 * whatever the node answers.
 *
 * Once the node has returned the account for that address, its on-chain public key is public
 * data: symbol_delegation_diagnose searches the delegation request by it (`signerPublicKey`), and
 * outputs may show it. A private key pasted by mistake derives an address that has no account,
 * so it never gets that far; the "looks like a secret" test below follows that path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../../src/cli/check.js';
import { formatCheckJson, formatCheckText } from '../../src/cli/format.js';
import { base32AddressToHex, publicKeyToAddress } from '../../src/domain/address.js';
import {
  createTestContext,
  fixture,
  H,
  jsonResponse,
  mainnetRoutes,
  type RouteHandler,
  type Routes,
  resourceNotFound,
  startTestServer,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The fixture main account: its public key and the mainnet address derived from it. */
const PUBLIC_KEY = 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E';
const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';

/** One call per argument that takes an account, with that argument set to `account`. */
function accountCalls(account: string): Array<[string, Record<string, unknown>]> {
  return [
    ['symbol_account_get', { account }],
    ['symbol_voting_key_status', { account }],
    ['symbol_harvesting_income', { account, fromHeight: 5_763_675, toHeight: 5_763_675 }],
    ['symbol_finality_participation', { account, epoch: 4010 }],
    ['symbol_delegation_diagnose', { account }],
    ['symbol_account_rank', { account, top: 5 }],
    ['symbol_holdings_value', { account, unitPrice: '1', currency: 'JPY' }],
    ['symbol_transaction_search', { address: account }],
    ['symbol_address_parse', { value: account }],
  ];
}

/** The tools of accountCalls that read /accounts/{id}, so a failure there reaches their result. */
const READS_ACCOUNT = new Set([
  'symbol_account_get',
  'symbol_voting_key_status',
  'symbol_harvesting_income',
  'symbol_finality_participation',
  'symbol_delegation_diagnose',
  'symbol_account_rank',
  'symbol_holdings_value',
]);

function contains(text: string, value: string): boolean {
  return text.toUpperCase().includes(value.toUpperCase());
}

function containsKey(text: string): boolean {
  return contains(text, PUBLIC_KEY);
}

/**
 * Where a request carries `value`: its path, or the names of the query parameters that do. The
 * requests of one call are passed in.
 */
function carriers(requests: readonly URL[], value: string): string[] {
  const out: string[] = [];
  for (const url of requests) {
    if (contains(url.pathname, value)) out.push(`path ${url.pathname}`);
    for (const [name, param] of url.searchParams) {
      if (contains(param, value)) out.push(`query ${name}`);
    }
  }
  return out;
}

/** Every way a node request can fail, as the REST client classifies it. */
const FAILURES: Array<[string, RouteHandler]> = [
  [
    'timeout',
    () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
  ],
  [
    'unreachable',
    () => {
      throw new TypeError('fetch failed');
    },
  ],
  ['http 500', () => jsonResponse({ code: 'Internal', message: 'internal error' }, 500)],
  ['http 429', () => jsonResponse({ code: 'TooManyRequests', message: 'slow down' }, 429)],
  ['invalid response', () => jsonResponse({ unexpected: true })],
  [
    'too large',
    () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) },
      }),
  ],
  [
    'route not found',
    (_request, url) =>
      jsonResponse({ code: 'ResourceNotFound', message: `${url.pathname} does not exist` }, 404),
  ],
  [
    'redirect',
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
  ],
];

/** The default routes with the account's own lookup failing, under its address and its key. */
function failingAccountRoutes(failure: RouteHandler): Routes {
  return {
    ...mainnetRoutes(),
    [`GET /accounts/${ADDRESS}`]: failure,
    [`GET /accounts/${PUBLIC_KEY}`]: failure,
  };
}

describe('a 64-hex account argument', () => {
  it('is turned into its address before any request, with the same answer as the address', async () => {
    server = await startTestServer();
    for (const key of [PUBLIC_KEY, PUBLIC_KEY.toLowerCase()]) {
      const byKey = accountCalls(key);
      const byAddress = accountCalls(ADDRESS);
      for (const [index, [name, args]] of byKey.entries()) {
        const before = server.requests.length;
        const result = await server.callTool(name, args);
        const sent = server.requests.slice(before);
        expect(result.isError, name).toBe(false);
        // Only the on-chain key the node returned for the address, in the delegation search.
        expect(carriers(sent, PUBLIC_KEY), name).toEqual(
          name === 'symbol_delegation_diagnose' ? ['query signerPublicKey'] : [],
        );
        if (READS_ACCOUNT.has(name)) {
          expect(
            sent.some((u) => u.pathname === `/accounts/${ADDRESS}`),
            name,
          ).toBe(true);
        }
        if (name === 'symbol_address_parse') continue; // reports the key itself (its own input)
        const [, addressArgs] = byAddress[index] ?? [];
        const direct = await server.callTool(name, addressArgs ?? {});
        expect(result.structuredContent, name).toEqual(direct.structuredContent);
      }
    }
  });

  it('that looks like a secret is never sent, logged or shown', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'DEADBEEF'.repeat(8); // no account has the address derived from it
    const derived = publicKeyToAddress(secret, 104);
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${derived}`]: resourceNotFound(derived) },
    });
    for (const [name, args] of accountCalls(secret)) {
      const before = server.requests.length;
      const result = await server.callTool(name, args);
      expect(carriers(server.requests.slice(before), secret), name).toEqual([]);
      if (name === 'symbol_address_parse') continue; // reports its own input as a public key
      expect(contains(result.text, secret), `${name}: ${result.text}`).toBe(false);
      if (READS_ACCOUNT.has(name) && name !== 'symbol_delegation_diagnose') {
        expect(result.isError, name).toBe(true);
      }
    }
    expect(contains(logged.mock.calls.flat().map(String).join('\n'), secret)).toBe(false);
  });

  for (const [kind, failure] of FAILURES) {
    it(`is never quoted when the account lookup fails (${kind})`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      server = await startTestServer({ routes: failingAccountRoutes(failure) });
      for (const [name, args] of accountCalls(PUBLIC_KEY)) {
        const before = server.requests.length;
        const result = await server.callTool(name, args);
        expect(carriers(server.requests.slice(before), PUBLIC_KEY), name).toEqual([]);
        if (!READS_ACCOUNT.has(name)) continue; // did not read the account: no error to check
        expect(result.isError, name).toBe(true);
        expect(containsKey(result.text), `${name}: ${result.text}`).toBe(false);
      }
      expect(containsKey(logged.mock.calls.flat().map(String).join('\n'))).toBe(false);
    });
  }

  for (const [kind, failure] of FAILURES) {
    it(`is not quoted when the delegation request search fails (${kind})`, async () => {
      // The search carries the on-chain key the node returned for the address; a failure of it
      // must not quote that key in full either.
      server = await startTestServer({
        routes: { ...mainnetRoutes(), 'GET /transactions/confirmed': failure },
      });
      const before = server.requests.length;
      const result = await server.callTool('symbol_delegation_diagnose', { account: PUBLIC_KEY });
      const sent = server.requests.slice(before);
      expect(sent.some((u) => u.pathname === '/transactions/confirmed')).toBe(true);
      expect(result.isError).toBe(true);
      expect(containsKey(result.text), result.text).toBe(false);
    });
  }

  it('is not what the delegation search sends: that is the key the node returned', async () => {
    // A node that answers the derived address with an account whose on-chain key differs from
    // the argument. The search must use the node's key, and the argument must be in no request.
    const argument = H('fixture:argument-key');
    const onChain = H('fixture:on-chain-key');
    const derived = publicKeyToAddress(argument, 104);
    const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    account.account.address = base32AddressToHex(derived);
    account.account.publicKey = onChain;
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${derived}`]: account },
    });
    const result = await server.callTool('symbol_delegation_diagnose', { account: argument });
    expect(result.isError, result.text).toBe(false);
    const search = server.requests.find((u) => u.pathname === '/transactions/confirmed');
    expect(search?.searchParams.get('signerPublicKey')).toBe(onChain);
    expect(carriers(server.requests, argument)).toEqual([]);
    expect(contains(result.text, argument)).toBe(false);
  });

  it('is turned into an address of the configured network (testnet: T...)', async () => {
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    const testnetAddress = publicKeyToAddress(PUBLIC_KEY, 152);
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        'GET /node/info': {
          ...info,
          networkIdentifier: 152,
          networkGenerationHashSeed:
            '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4',
        },
        [`GET /accounts/${testnetAddress}`]: resourceNotFound(testnetAddress),
      },
    });
    expect(server.ctx.network.name).toBe('testnet');
    const result = await server.callTool('symbol_account_get', { account: PUBLIC_KEY });
    expect(result.text).toMatch(/No account with public key CE199233… exists on testnet/);
    const asked = server.requests.filter((u) => u.pathname.startsWith('/accounts/'));
    expect(asked.map((u) => u.pathname)).toEqual([`/accounts/${testnetAddress}`]);
    expect(testnetAddress.startsWith('T')).toBe(true);
  });

  for (const [kind, failure] of FAILURES) {
    it(`is never printed by the CLI check when the account lookup fails (${kind})`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const proof = fixture<Record<string, unknown>>('mainnet/finalization-proof-epoch.json');
      const { ctx, requests } = await createTestContext({
        routes: {
          ...failingAccountRoutes(failure),
          'GET /finalization/proof/epoch/4004': { ...proof, finalizationEpoch: 4004 },
        },
      });
      const report = await runCheck(ctx, { account: PUBLIC_KEY, warnDays: 14 });
      expect(report.checks.find((c) => c.id === 'voting_key_status')?.status).toBe('fail');
      expect(containsKey(formatCheckText(report))).toBe(false);
      expect(containsKey(formatCheckJson(report))).toBe(false);
      expect(carriers(requests, PUBLIC_KEY)).toEqual([]);
      expect(containsKey(logged.mock.calls.flat().map(String).join('\n'))).toBe(false);
    });
  }

  it('is not sent by the CLI check when the node answers normally either', async () => {
    const proof = fixture<Record<string, unknown>>('mainnet/finalization-proof-epoch.json');
    const { ctx, requests } = await createTestContext({
      routes: {
        ...mainnetRoutes(),
        'GET /finalization/proof/epoch/4004': { ...proof, finalizationEpoch: 4004 },
      },
    });
    const report = await runCheck(ctx, { account: PUBLIC_KEY, warnDays: 14 });
    expect(report.account).toBe(ADDRESS);
    expect(report.checks.find((c) => c.id === 'voting_key_status')?.status).toBe('ok');
    expect(requests.some((u) => u.pathname === `/accounts/${ADDRESS}`)).toBe(true);
    expect(carriers(requests, PUBLIC_KEY)).toEqual([]);
    expect(containsKey(formatCheckText(report))).toBe(false);
  });
});
