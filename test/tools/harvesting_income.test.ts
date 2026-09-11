import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/server.js';
import {
  fixture,
  jsonResponse,
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
/** Anchor: the captured block 5764879 (network timestamp 173192454149 = 2026-09-10T13:07:19.149Z). */
const ANCHOR_HEIGHT = 5_764_879;
const ANCHOR_TS = 173_192_454_149;
const STEP_MS = 30_000;
const TIP = 5_770_000;
const NOW = new Date('2026-09-12T08:00:00.000Z');

type StatementPage = {
  data: Array<{ statement: { height: string }; meta: { timestamp: string } }>;
};

/** Linear block clock for the binary search: 30 s per block around the anchor, never negative. */
function blockAt(height: number) {
  const ts = Math.max(0, ANCHOR_TS + (height - ANCHOR_HEIGHT) * STEP_MS);
  return { meta: {}, block: { height: String(height), timestamp: String(ts) } };
}

function statementsRoute(pageFor: (pageNumber: number, from: number, to: number) => unknown[]) {
  return (_request: Request, url: URL) => {
    const pageNumber = Number(url.searchParams.get('pageNumber') ?? '1');
    const from = Number(url.searchParams.get('fromHeight') ?? '0');
    const to = Number(url.searchParams.get('toHeight') ?? String(Number.MAX_SAFE_INTEGER));
    return jsonResponse({
      data: pageFor(pageNumber, from, to),
      pagination: { pageNumber, pageSize: 100 },
    });
  };
}

/** Default: the captured page filtered by the requested height range, then nothing. */
function routes(extra: Routes = {}): Routes {
  const page = fixture<StatementPage>('mainnet/statements-harvest-page1.json');
  const chain = fixture<{ height: string }>('mainnet/chain-info.json');
  return {
    ...mainnetRoutes(),
    'GET /chain/info': { ...chain, height: String(TIP) },
    'GET /blocks/*': (_request: Request, url: URL) =>
      jsonResponse(blockAt(Number(url.pathname.split('/').pop()))),
    'GET /statements/transaction': statementsRoute((pageNumber, from, to) =>
      pageNumber === 1
        ? page.data.filter((r) => {
            const h = Number(r.statement.height);
            return h >= from && h <= to;
          })
        : [],
    ),
    ...extra,
  };
}

/** Synthetic statements cloned from the first captured row, one per block from `startHeight`. */
function syntheticStatements(startHeight: number, count: number) {
  const row = fixture<StatementPage>('mainnet/statements-harvest-page1.json').data[0];
  if (!row) throw new Error('fixture row missing');
  return Array.from({ length: count }, (_, i) => ({
    ...row,
    statement: { ...row.statement, height: String(startHeight + i) },
    meta: { timestamp: String(ANCHOR_TS + (startHeight + i - ANCHOR_HEIGHT) * STEP_MS) },
  }));
}

const outputSchema = TOOLS.find((t) => t.name === 'symbol_harvesting_income')?.outputSchema;

describe('symbol_harvesting_income', () => {
  it('totals a height range per UTC day with exact integer sums', async () => {
    server = await startTestServer({ routes: routes(), now: NOW });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_764_879,
      toHeight: 5_767_496,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc)[0]).toBe('summary');
    expect(outputSchema?.safeParse(sc).success).toBe(true);
    expect(result.text).toBe(JSON.stringify(sc, null, 2));

    expect(sc).toMatchObject({
      network: 'mainnet',
      address: ADDRESS,
      currency: { id: '6BED913FA20223F8', alias: 'symbol.xym', divisibility: 6 },
      period: { kind: 'heights', fromDate: null, toDate: null, timeZone: 'UTC' },
      range: {
        fromHeight: 5_764_879,
        toHeight: 5_767_496,
        fromTime: { utc: '2026-09-10T13:07:19.149Z' },
        toTime: { utc: '2026-09-11T10:55:49.149Z' },
        blocks: 2618,
      },
      totals: {
        receipts: 20,
        xym: '662.574177',
        raw: '662574177',
        receiptsHarvester: 9,
        xymHarvester: '461.240390',
        rawHarvester: '461240390',
        receiptsBeneficiary: 11,
        xymBeneficiary: '201.333787',
        rawBeneficiary: '201333787',
        receiptsUnknown: 0,
        xymUnknown: '0.000000',
        rawUnknown: '0',
      },
      daily: [
        {
          date: '2026-09-10',
          receipts: 8,
          xym: '278.198648',
          raw: '278198648',
          receiptsHarvester: 4,
          xymHarvester: '204.988480',
          receiptsBeneficiary: 4,
          xymBeneficiary: '73.210168',
        },
        {
          date: '2026-09-11',
          receipts: 12,
          xym: '384.375529',
          raw: '384375529',
          receiptsHarvester: 5,
          xymHarvester: '256.251910',
          receiptsBeneficiary: 7,
          xymBeneficiary: '128.123619',
        },
      ],
      receiptsListed: 0,
      unknownStatements: 0,
      shares: { harvesterPercentage: 70, beneficiaryPercentage: 25, networkPercentage: 5 },
      pagesFetched: 1,
      statementsFetched: 11,
      truncated: false,
      truncationReasons: [],
    });
    expect(sc.receipts).toBeUndefined();
    expect(sc.summary).toMatch(/20 harvest receipts totalling 662\.574177 symbol\.xym/);
    expect(sc.summary).toMatch(
      /harvester 461\.240390 in 9 blocks, beneficiary 201\.333787 in 11 blocks/,
    );
    expect(sc.summary).toMatch(
      /Per day \(UTC\): 2026-09-10 278\.198648 \(8\), 2026-09-11 384\.375529 \(12\)/,
    );
    expect((sc.notes as string[]).join(' ')).toMatch(/no fiat conversion/);

    const statementCalls = server.requests.filter((u) => u.pathname === '/statements/transaction');
    expect(statementCalls).toHaveLength(1);
    expect(Object.fromEntries(statementCalls[0]?.searchParams ?? [])).toEqual({
      receiptType: '8515',
      targetAddress: ADDRESS,
      fromHeight: '5764879',
      toHeight: '5767496',
      pageSize: '100',
      order: 'asc',
      pageNumber: '1',
    });
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('lists receipts with local times when SYMBOL_TIMEZONE is set', async () => {
    server = await startTestServer({
      routes: routes(),
      now: NOW,
      env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
    });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_764_879,
      toHeight: 5_767_496,
      granularity: 'receipt',
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(outputSchema?.safeParse(sc).success).toBe(true);
    expect(sc.daily).toBeUndefined();
    const receipts = sc.receipts as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(20);
    expect(receipts[0]).toEqual({
      height: 5_764_879,
      timestamp: { utc: '2026-09-10T13:07:19.149Z', local: '2026-09-10T22:07:19+09:00' },
      kind: 'harvester',
      xym: '51.247120',
      raw: '51247120',
    });
    expect(receipts[1]).toMatchObject({ height: 5_764_879, kind: 'beneficiary', raw: '18302542' });
    expect(receipts[10]).toMatchObject({ height: 5_766_293, kind: 'beneficiary' });
    expect(sc).toMatchObject({
      period: { timeZone: 'Asia/Tokyo' },
      receiptsListed: 20,
      truncated: false,
    });
    expect(sc.summary).toMatch(/receipts lists 20 of 20 receipts/);
  });

  it('resolves a date range to heights by binary search over block timestamps (UTC)', async () => {
    server = await startTestServer({ routes: routes(), now: NOW });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromDate: '2026-09-10',
      toDate: '2026-09-11',
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      period: { kind: 'dates', fromDate: '2026-09-10', toDate: '2026-09-11', timeZone: 'UTC' },
      range: {
        fromHeight: 5_763_305,
        toHeight: 5_769_064,
        fromTime: { utc: '2026-09-10T00:00:19.149Z' },
        toTime: { utc: '2026-09-11T23:59:49.149Z' },
      },
      totals: { receipts: 20, raw: '662574177' },
    });
    expect(sc.summary).toMatch(/2026-09-10 to 2026-09-11 \(UTC; heights 5,763,305-5,769,064/);
    const params = server.requests.find(
      (u) => u.pathname === '/statements/transaction',
    )?.searchParams;
    expect(params?.get('fromHeight')).toBe('5763305');
    expect(params?.get('toHeight')).toBe('5769064');
    const blockCalls = server.requests.filter((u) => u.pathname.startsWith('/blocks/'));
    expect(blockCalls.length).toBeLessThanOrEqual(2 * 24);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('uses the configured zone for day boundaries and buckets', async () => {
    server = await startTestServer({
      routes: routes(),
      now: NOW,
      env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
    });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromDate: '2026-09-10',
      toDate: '2026-09-11',
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      period: { timeZone: 'Asia/Tokyo' },
      range: {
        fromHeight: 5_762_225,
        toHeight: 5_767_984,
        fromTime: { utc: '2026-09-09T15:00:19.149Z', local: '2026-09-10T00:00:19+09:00' },
      },
      totals: { receipts: 20 },
    });
    expect(
      (sc.daily as Array<{ date: string; receipts: number }>).map((d) => [d.date, d.receipts]),
    ).toEqual([
      ['2026-09-10', 2],
      ['2026-09-11', 18],
    ]);
  });

  it('reads pages until a short page and caps the receipt list by format', async () => {
    const pages = routes({
      'GET /statements/transaction': statementsRoute((pageNumber) =>
        pageNumber <= 2 ? syntheticStatements(5_764_879 + (pageNumber - 1) * 100, 100) : [],
      ),
    });
    server = await startTestServer({ routes: pages, now: NOW });
    const concise = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_764_879,
      toHeight: 5_765_078,
      granularity: 'receipt',
    });
    expect(concise.isError).toBe(false);
    expect(concise.structuredContent).toMatchObject({
      pagesFetched: 3,
      statementsFetched: 200,
      totals: { receipts: 400, receiptsHarvester: 200, receiptsBeneficiary: 200 },
      receiptsListed: 50,
      truncated: true,
      truncationReasons: ['receiptList'],
    });
    expect((concise.structuredContent as { receipts: unknown[] }).receipts).toHaveLength(50);
    expect(concise.structuredContent?.summary).toMatch(
      /lists 50 of 400 receipts \(use format=detailed/,
    );

    const detailed = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_764_879,
      toHeight: 5_765_078,
      granularity: 'receipt',
      format: 'detailed',
    });
    expect(detailed.structuredContent).toMatchObject({
      receiptsListed: 400,
      truncated: false,
      truncationReasons: [],
    });
    expect(outputSchema?.safeParse(detailed.structuredContent).success).toBe(true);
  });

  it('stops at the page limit and reports the totals as incomplete', async () => {
    const endless = routes({
      'GET /statements/transaction': statementsRoute((pageNumber) =>
        syntheticStatements(5_000_000 + (pageNumber - 1) * 100, 100),
      ),
    });
    server = await startTestServer({ routes: endless, now: NOW });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_000_000,
      toHeight: 5_700_000,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      pagesFetched: 200,
      statementsFetched: 20_000,
      totals: { receipts: 40_000 },
      truncated: true,
      truncationReasons: ['pageLimit'],
    });
    expect(result.structuredContent?.summary).toMatch(
      /Narrow the period or split it with fromHeight\/toHeight/,
    );
    expect(server.requests.filter((u) => u.pathname === '/statements/transaction')).toHaveLength(
      200,
    );
  });

  it('caps toHeight at the current height and notes it', async () => {
    server = await startTestServer({ routes: routes(), now: NOW });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_767_000,
      toHeight: 9_000_000,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      range: { fromHeight: 5_767_000, toHeight: TIP },
      totals: { receipts: 6 },
    });
    const notes = (result.structuredContent as { notes: string[] }).notes;
    expect(notes.join(' ')).toMatch(/capped at 5,770,000/);
  });

  it('reports an empty period without erroring', async () => {
    server = await startTestServer({ routes: routes(), now: NOW });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_000_000,
      toHeight: 5_000_100,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      totals: { receipts: 0, xym: '0.000000', raw: '0' },
      daily: [],
    });
    expect(result.structuredContent?.summary).toMatch(/No harvest receipts in this period/);
  });

  describe('input validation', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'rejects dates and heights together',
        { fromDate: '2026-09-10', toDate: '2026-09-11', fromHeight: 1, toHeight: 2 },
        /Both a date range and a height range/,
      ],
      ['rejects a missing period', {}, /No period was given/],
      ['rejects fromHeight without toHeight', { fromHeight: 10 }, /must be given together/],
      ['rejects toDate without fromDate', { toDate: '2026-09-11' }, /must be given together/],
      [
        'rejects fromHeight above toHeight',
        { fromHeight: 20, toHeight: 10 },
        /fromHeight 20 is above toHeight 10/,
      ],
      [
        'rejects an impossible date',
        { fromDate: '2026-02-30', toDate: '2026-03-01' },
        /"2026-02-30" is not a valid YYYY-MM-DD date/,
      ],
      [
        'rejects a malformed date',
        { fromDate: '2026/09/10', toDate: '2026-09-11' },
        /not a valid YYYY-MM-DD date/,
      ],
      [
        'rejects fromDate after toDate',
        { fromDate: '2026-09-11', toDate: '2026-09-10' },
        /fromDate 2026-09-11 is after toDate 2026-09-10/,
      ],
      [
        'rejects a period after the latest block',
        { fromDate: '2026-12-01', toDate: '2026-12-31' },
        /after the latest block/,
      ],
      [
        'rejects a period before the first block',
        { fromDate: '2020-01-01', toDate: '2020-01-31' },
        /ends before the first block/,
      ],
    ];
    for (const [name, args, pattern] of cases) {
      it(name, async () => {
        server = await startTestServer({ routes: routes(), now: NOW });
        const result = await server.callTool('symbol_harvesting_income', {
          account: ADDRESS,
          ...args,
        });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(pattern);
        expect(result.text).toMatch(/fromDate|fromHeight|period/);
      });
    }

    it('rejects an invalid account before contacting the node for statements', async () => {
      server = await startTestServer({ routes: routes(), now: NOW });
      const result = await server.callTool('symbol_harvesting_income', {
        account: 'not-an-account',
        fromHeight: 1,
        toHeight: 2,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/not a valid Symbol account identifier/);
      expect(server.requests.some((u) => u.pathname === '/statements/transaction')).toBe(false);
    });
  });
});
