import { afterEach, describe, expect, it, vi } from 'vitest';
import { base32AddressToHex, publicKeyToAddress } from '../../src/domain/address.js';
import { TOOLS } from '../../src/server.js';
import {
  ALIAS_NAMESPACE_ID,
  ALIAS_NAMESPACE_NAME,
  accountSearchRoute,
  FIXTURE_HOLDER_RANK,
  fixture,
  H,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  SYNTHETIC_HOLDER_COUNT,
  startTestServer,
  syntheticHolders,
  TEST_NODE_HOST,
  type TestServer,
  type ToolCallResult,
  XYM_MOSAIC_ID,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const TOOL = 'symbol_account_rank';
const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const OTHER_MOSAIC_ID = '66BAE04E8758599E';
/** Synthetic holder #1: H("fixture:holder-001") as a public key, mainnet address. */
const HOLDER_1_ADDRESS = publicKeyToAddress(H('fixture:holder-001'), 104);
/** An account that exists (served from the account fixture) but is not in the holder list. */
const OUTSIDER_ADDRESS = publicKeyToAddress(H('fixture:counterparty-1'), 104);
/** A valid address the fake node knows nothing about. */
const UNKNOWN_ADDRESS = publicKeyToAddress(H('fixture:counterparty-2'), 104);

// Supply 7,842,928,625 XYM (mosaic-xym.json); balances are FIXTURE_XYM_BALANCE + (157 - n) x 1,000 XYM.
const MAIN_SHARE = '0.0551';
const TOP20_SHARE = '1.1392';
const TOP5_SHARE = '0.2853';

type Output = {
  summary: string;
  mosaic: {
    id: string;
    alias: string | null;
    divisibility: number;
    supply: string;
    supplyRaw: string;
  };
  accountResolution: unknown;
  account: {
    address: string;
    rank: number | null;
    rankBeyond: number | null;
    balance: string;
    balanceRaw: string;
    sharePercent: string | null;
  } | null;
  topHolders: Array<{
    rank: number;
    address: string;
    balance: string;
    balanceRaw: string;
    sharePercent: string | null;
  }>;
  topHoldersSharePercent: string | null;
  fetch: { pagesFetched: number; accountsScanned: number };
  notes: string[];
};

const outputSchema = TOOLS.find((t) => t.name === TOOL)?.outputSchema;

function checkShape(result: ToolCallResult): Output {
  expect(result.isError).toBe(false);
  const sc = result.structuredContent as Output;
  expect(outputSchema?.safeParse(sc).success).toBe(true);
  expect(Object.keys(sc)[0]).toBe('summary');
  expect(result.text).toBe(JSON.stringify(sc, null, 2));
  return sc;
}

function accountSearchRequests(s: TestServer) {
  return s.requests
    .filter((u) => u.pathname === '/accounts')
    .map((u) => Object.fromEntries(u.searchParams));
}

function expectOnlyTestNode(s: TestServer) {
  expect(new Set(s.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
}

function pageQuery(pageNumber: number, mosaicId = XYM_MOSAIC_ID) {
  return {
    mosaicId,
    orderBy: 'balance',
    order: 'desc',
    pageSize: '100',
    pageNumber: String(pageNumber),
  };
}

describe('symbol_account_rank', () => {
  it('finds the account on the second page (rank 157) and lists the top 20 holders', async () => {
    server = await startTestServer();
    const result = await server.callTool(TOOL, { account: ADDRESS });
    const sc = checkShape(result);

    expect(sc.mosaic).toEqual({
      id: XYM_MOSAIC_ID,
      alias: 'symbol.xym',
      divisibility: 6,
      supply: '7842928625.000000',
      supplyRaw: '7842928625000000',
    });
    expect(sc.accountResolution).toBeNull();
    expect(sc.account).toEqual({
      address: ADDRESS,
      rank: FIXTURE_HOLDER_RANK,
      rankBeyond: null,
      balance: '4321000.000000',
      balanceRaw: '4321000000000',
      sharePercent: MAIN_SHARE,
    });
    expect(sc.topHolders).toHaveLength(20);
    expect(sc.topHolders[0]).toEqual({
      rank: 1,
      address: HOLDER_1_ADDRESS,
      balance: '4477000.000000',
      balanceRaw: '4477000000000',
      sharePercent: '0.0571',
    });
    expect(sc.topHolders.map((h) => h.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(sc.topHolders[19]?.balanceRaw).toBe('4458000000000');
    expect(sc.topHolders.some((h) => h.address === ADDRESS)).toBe(false);
    expect(sc.topHoldersSharePercent).toBe(TOP20_SHARE);
    expect(sc.fetch).toEqual({ pagesFetched: 2, accountsScanned: 200 });

    expect(sc.summary.split('\n')).toEqual([
      `${ADDRESS} holds 4,321,000.000000 symbol.xym (${MAIN_SHARE}% of supply), rank 157 by symbol.xym balance.`,
      `Top 20 symbol.xym holders own ${TOP20_SHARE}% of supply (7,842,928,625.000000 symbol.xym in circulation).`,
    ]);
    expect(sc.notes.some((n) => /not by importance/.test(n))).toBe(true);
    expect(sc.notes.some((n) => /equal balances/.test(n))).toBe(true);
    expect(sc.notes.some((n) => /attaches no labels/.test(n))).toBe(true);
    expect(sc.notes.some((n) => /public chain data/.test(n))).toBe(true);
    expect(sc.notes.some((n) => /stopped at maxRank/.test(n))).toBe(false);

    // Exactly two holder pages, ascending, with the query the OpenAPI spec requires.
    expect(accountSearchRequests(server)).toEqual([pageQuery(1), pageQuery(2)]);
    expect(server.requests.some((u) => u.pathname === `/accounts/${ADDRESS}`)).toBe(true);
    expectOnlyTestNode(server);
  });

  it('lists the top holders only when no account is given', async () => {
    server = await startTestServer();
    const sc = checkShape(await server.callTool(TOOL, {}));
    expect(sc.account).toBeNull();
    expect(sc.accountResolution).toBeNull();
    expect(sc.topHolders).toHaveLength(20);
    expect(sc.topHoldersSharePercent).toBe(TOP20_SHARE);
    expect(sc.fetch).toEqual({ pagesFetched: 1, accountsScanned: 100 });
    expect(sc.summary).toBe(
      `Top 20 symbol.xym holders own ${TOP20_SHARE}% of supply (7,842,928,625.000000 symbol.xym in circulation).`,
    );
    expect(accountSearchRequests(server)).toEqual([pageQuery(1)]);
    expect(server.requests.some((u) => u.pathname.startsWith('/accounts/'))).toBe(false);
    expectOnlyTestNode(server);
  });

  it('honours top at both ends of its range', async () => {
    server = await startTestServer();
    const five = checkShape(await server.callTool(TOOL, { top: 5 }));
    expect(five.topHolders).toHaveLength(5);
    expect(five.topHoldersSharePercent).toBe(TOP5_SHARE);
    expect(five.summary).toMatch(/^Top 5 symbol\.xym holders own 0\.2853% of supply/);

    const one = checkShape(await server.callTool(TOOL, { top: 1 }));
    expect(one.topHolders).toHaveLength(1);
    expect(one.topHoldersSharePercent).toBe('0.0571');

    const hundred = checkShape(await server.callTool(TOOL, { top: 100 }));
    expect(hundred.topHolders).toHaveLength(100);
    expect(hundred.topHolders[99]?.rank).toBe(100);
    expect(hundred.fetch.pagesFetched).toBe(1);
  });

  it('rejects top and maxRank outside their ranges before contacting the node', async () => {
    server = await startTestServer();
    const before = server.requests.length;
    for (const args of [{ top: 0 }, { top: 101 }, { maxRank: 99 }, { maxRank: 5001 }]) {
      const result = await server.callTool(TOOL, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(server.requests.length).toBe(before);
  });

  it('stops at maxRank and says so when the account ranks lower', async () => {
    server = await startTestServer();
    const sc = checkShape(await server.callTool(TOOL, { account: ADDRESS, maxRank: 100 }));
    expect(sc.account).toMatchObject({
      address: ADDRESS,
      rank: null,
      rankBeyond: 100,
      balance: '4321000.000000',
      sharePercent: MAIN_SHARE,
    });
    expect(sc.fetch).toEqual({ pagesFetched: 1, accountsScanned: 100 });
    expect(sc.summary.split('\n')[0]).toBe(
      `${ADDRESS} holds 4,321,000.000000 symbol.xym (${MAIN_SHARE}% of supply) but is not within the top 100 holders; raise maxRank (up to 5,000) to look further.`,
    );
    expect(
      sc.notes.some((n) => /stopped at maxRank 100 \(1 requests of 100 holders\)/.test(n)),
    ).toBe(true);
    expect(accountSearchRequests(server)).toEqual([pageQuery(1)]);
    expectOnlyTestNode(server);
  });

  it('reads until the holder list ends when the account is not in it', async () => {
    const outsider = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    outsider.account.address = base32AddressToHex(OUTSIDER_ADDRESS);
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${OUTSIDER_ADDRESS}`]: outsider },
    });
    const sc = checkShape(await server.callTool(TOOL, { account: OUTSIDER_ADDRESS }));
    expect(sc.account).toMatchObject({
      address: OUTSIDER_ADDRESS,
      rank: null,
      rankBeyond: null,
      balance: '4321000.000000',
    });
    expect(sc.fetch).toEqual({
      pagesFetched: SYNTHETIC_HOLDER_COUNT / 100 + 1,
      accountsScanned: SYNTHETIC_HOLDER_COUNT,
    });
    expect(sc.summary.split('\n')[0]).toMatch(
      /but did not appear among the 300 holders the node listed for symbol\.xym\.$/,
    );
    expect(sc.notes.some((n) => /listed 300 holders of symbol\.xym in total/.test(n))).toBe(true);
    expect(accountSearchRequests(server).map((q) => q.pageNumber)).toEqual(['1', '2', '3', '4']);
    expectOnlyTestNode(server);
  });

  it('does not scan past the first page for an account that holds none of the mosaic', async () => {
    const acct = fixture<{ account: { mosaics: unknown[] } }>('mainnet/account-voting.json');
    acct.account.mosaics = [{ id: OTHER_MOSAIC_ID, amount: '1000000000' }];
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: acct },
    });
    const sc = checkShape(await server.callTool(TOOL, { account: ADDRESS }));
    expect(sc.account).toMatchObject({
      rank: null,
      rankBeyond: null,
      balance: '0.000000',
      balanceRaw: '0',
      sharePercent: '0.0000',
    });
    expect(sc.fetch).toEqual({ pagesFetched: 1, accountsScanned: 100 });
    expect(sc.summary.split('\n')[0]).toMatch(/so it has no rank among symbol\.xym holders\.$/);
    expect(sc.topHolders).toHaveLength(20);
  });

  it('ranks by another mosaic given as a hex id', async () => {
    const other = fixture<{ mosaic: Record<string, unknown> }>('mainnet/mosaic-other.json');
    other.mosaic.supply = '100000000000000';
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        [`GET /mosaics/${OTHER_MOSAIC_ID}`]: other,
        'GET /accounts': accountSearchRoute(syntheticHolders(30, OTHER_MOSAIC_ID)),
      },
    });
    const sc = checkShape(await server.callTool(TOOL, { mosaic: OTHER_MOSAIC_ID, top: 5 }));
    expect(sc.mosaic).toEqual({
      id: OTHER_MOSAIC_ID,
      alias: null,
      divisibility: 0,
      supply: '100000000000000',
      supplyRaw: '100000000000000',
    });
    expect(sc.topHolders[0]).toEqual({
      rank: 1,
      address: HOLDER_1_ADDRESS,
      balance: '4477000000000',
      balanceRaw: '4477000000000',
      sharePercent: '4.4770',
    });
    expect(sc.fetch).toEqual({ pagesFetched: 1, accountsScanned: 30 });
    expect(sc.summary).toMatch(/^Top 5 66BAE04E8758599E holders own 22\.3750% of supply/);
    expect(accountSearchRequests(server)).toEqual([pageQuery(1, OTHER_MOSAIC_ID)]);
    expect(server.requests.some((u) => u.pathname === `/mosaics/${OTHER_MOSAIC_ID}`)).toBe(true);
    expectOnlyTestNode(server);
  });

  it('accepts the mosaic as an alias name', async () => {
    server = await startTestServer();
    const sc = checkShape(await server.callTool(TOOL, { mosaic: 'symbol.xym', top: 5 }));
    expect(sc.mosaic).toMatchObject({ id: XYM_MOSAIC_ID, alias: 'symbol.xym', divisibility: 6 });
    expect(sc.topHoldersSharePercent).toBe(TOP5_SHARE);
    const paths = server.requests.map((u) => u.pathname);
    expect(paths).toContain('/namespaces/E74B99BA41F4AFEE');
    expect(paths).toContain(`/mosaics/${XYM_MOSAIC_ID}`);
    expectOnlyTestNode(server);
  });

  it('resolves a namespace name to the account and prefixes the summary', async () => {
    server = await startTestServer();
    const sc = checkShape(await server.callTool(TOOL, { account: ALIAS_NAMESPACE_NAME }));
    expect(sc.account).toMatchObject({ address: ADDRESS, rank: FIXTURE_HOLDER_RANK });
    expect(sc.accountResolution).toEqual({
      input: ALIAS_NAMESPACE_NAME,
      namespace: ALIAS_NAMESPACE_NAME,
      namespaceId: ALIAS_NAMESPACE_ID,
      address: ADDRESS,
    });
    expect(sc.summary.startsWith(`${ALIAS_NAMESPACE_NAME} → ${ADDRESS}. ${ADDRESS} holds`)).toBe(
      true,
    );
    expectOnlyTestNode(server);
  });

  it('lists every top holder in the summary with format detailed and keeps the JSON identical', async () => {
    server = await startTestServer();
    const concise = checkShape(await server.callTool(TOOL, { account: ADDRESS }));
    const detailed = checkShape(
      await server.callTool(TOOL, { account: ADDRESS, format: 'detailed' }),
    );
    const lines = detailed.summary.split('\n');
    expect(lines).toHaveLength(22);
    expect(lines.slice(0, 2)).toEqual(concise.summary.split('\n'));
    expect(lines[2]).toBe(`#1 ${HOLDER_1_ADDRESS}: 4,477,000.000000 symbol.xym (0.0571%)`);
    expect(lines[21]).toMatch(/^#20 [A-Z2-7]{39}: 4,458,000\.000000 symbol\.xym \(0\.0568%\)$/);
    expect({ ...detailed, summary: '' }).toEqual({ ...concise, summary: '' });
  });

  it('fails loudly when a holder page cannot be fetched', async () => {
    const routes: Routes = {
      ...mainnetRoutes(),
      'GET /accounts': () => jsonResponse({ code: 'Internal', message: 'boom' }, 500),
    };
    server = await startTestServer({ routes });
    const result = await server.callTool(TOOL, { account: ADDRESS });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/HTTP 500/);
    expect(result.text).toMatch(/\/accounts\?/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('gives a hinted error for an unknown account and for a bad identifier', async () => {
    server = await startTestServer();
    const unknown = await server.callTool(TOOL, { account: UNKNOWN_ADDRESS });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/No account with address/);
    expect(server.requests.some((u) => u.pathname === '/accounts')).toBe(false);

    const bad = await server.callTool(TOOL, { account: 'not an account' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not a valid Symbol account identifier/);
  });
});
