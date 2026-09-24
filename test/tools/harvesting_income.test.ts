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
        // 11 blocks: 9 the account harvested as its own beneficiary (two receipts each) and 2 where
        // another account harvested and it only got the beneficiary share.
        blocks: 11,
        blocksHarvested: 9,
        blocksBeneficiaryOnly: 2,
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
          blocks: 4,
          blocksHarvested: 4,
          blocksBeneficiaryOnly: 0,
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
          blocks: 7,
          blocksHarvested: 5,
          blocksBeneficiaryOnly: 2,
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
    const lines = (sc.summary as string).split('\n');
    expect(lines[0]).toMatch(
      /: 20 harvest receipts totalling 662\.574177 symbol\.xym from 11 blocks \(harvester share 461\.240390 in 9 receipts, beneficiary share 201\.333787 in 11 receipts\)\.$/,
    );
    // Receipts are shares: 11 beneficiary receipts are not 11 delegators' blocks.
    expect(lines[1]).toBe(
      "Blocks: 9 harvested by this account, 2 harvested by others that paid it only the beneficiary share (typically delegators on its node). 9 of the 11 beneficiary receipts come from blocks it harvested itself, as its own node's beneficiary.",
    );
    expect(lines[2]).toBe('Per day (UTC): 2026-09-10 278.198648 (8), 2026-09-11 384.375529 (12).');
    expect((sc.notes as string[]).join(' ')).toMatch(
      /Receipts are shares, not blocks: blocksHarvested and blocksBeneficiaryOnly count each block once\./,
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

  it('buckets by calendar month and keeps the period total as the first summary line', async () => {
    server = await startTestServer({ routes: routes(), now: NOW });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_764_879,
      toHeight: 5_767_496,
      granularity: 'monthly',
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(outputSchema?.safeParse(sc).success).toBe(true);
    expect(sc.daily).toBeUndefined();
    expect(sc.receipts).toBeUndefined();
    expect(sc.csv).toBeNull();
    expect(sc.monthly).toEqual([
      {
        month: '2026-09',
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
        blocks: 11,
        blocksHarvested: 9,
        blocksBeneficiaryOnly: 2,
      },
    ]);
    const lines = (sc.summary as string).split('\n');
    expect(lines[0]).toMatch(/^NCV5HR.* 20 harvest receipts totalling 662\.574177 symbol\.xym/);
    expect(lines[1]).toMatch(/^Blocks: 9 harvested by this account, 2 harvested by others/);
    expect(lines[2]).toBe(
      '2026-09: 20 receipts, 662.574177 symbol.xym; 11 blocks: 9 harvested by this account, 2 by others (receipts 9 harvester / 11 beneficiary)',
    );
    expect(result.text).toBe(JSON.stringify(sc, null, 2));
  });

  it('names the blocks whose share split is not recognised in the Blocks line', async () => {
    const me = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';
    const other = `68${'A'.repeat(46)}`;
    const sink = `68${'B'.repeat(46)}`;
    const receipt = (amount: string, targetAddress: string) => ({
      version: 1,
      type: 8515,
      targetAddress,
      mosaicId: '6BED913FA20223F8',
      amount,
    });
    const statementAt = (height: number, receipts: unknown[]) => ({
      statement: { height: String(height), source: { primaryId: 0, secondaryId: 0 }, receipts },
      id: `synthetic-${height}`,
      meta: { timestamp: String(ANCHOR_TS + (height - ANCHOR_HEIGHT) * STEP_MS) },
    });
    const statements = [
      statementAt(5_764_900, [receipt('70', other), receipt('25', me), receipt('5', sink)]),
      statementAt(5_764_901, [receipt('60', me), receipt('35', other), receipt('5', sink)]),
    ];
    server = await startTestServer({
      routes: routes({
        'GET /statements/transaction': statementsRoute((pageNumber) =>
          pageNumber === 1 ? statements : [],
        ),
      }),
      now: NOW,
    });
    const result = await server.callTool('symbol_harvesting_income', {
      account: ADDRESS,
      fromHeight: 5_764_879,
      toHeight: 5_767_496,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.totals).toMatchObject({
      receipts: 2,
      blocks: 2,
      blocksHarvested: 0,
      blocksBeneficiaryOnly: 1,
    });
    expect((sc.summary as string).split('\n')[1]).toBe(
      'Blocks: 0 harvested by this account, 1 harvested by others that paid it only the beneficiary share (typically delegators on its node), 1 not recognised.',
    );
    expect(outputSchema?.safeParse(sc).success).toBe(true);
  });

  describe('output=csv', () => {
    // The block columns were appended in 0.9.0: the columns before them keep their positions.
    const BUCKET_HEADER =
      'period,receipts,xym,raw,receipts_harvester,xym_harvester,raw_harvester,receipts_beneficiary,xym_beneficiary,raw_beneficiary,receipts_unknown,xym_unknown,raw_unknown,blocks,blocks_harvested,blocks_beneficiary_only';

    it('puts the daily rows in the text block and repeats them in csv', async () => {
      server = await startTestServer({ routes: routes(), now: NOW });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_764_879,
        toHeight: 5_767_496,
        output: 'csv',
      });
      expect(result.isError).toBe(false);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(outputSchema?.safeParse(sc).success).toBe(true);
      expect(result.text).toBe(
        [
          BUCKET_HEADER,
          '2026-09-10,8,278.198648,278198648,4,204.988480,204988480,4,73.210168,73210168,0,0.000000,0,4,4,0',
          '2026-09-11,12,384.375529,384375529,5,256.251910,256251910,7,128.123619,128123619,0,0.000000,0,7,5,2',
          '',
        ].join('\n'),
      );
      expect(sc.csv).toBe(result.text);
      expect(() => JSON.parse(result.text)).toThrow();
      expect(result.text).not.toContain('\r');
      expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
      // The JSON side is unchanged by the output switch.
      expect(sc.daily).toHaveLength(2);
      expect(sc.totals).toMatchObject({ receipts: 20, xym: '662.574177' });
      expect(sc.summary).toMatch(/CSV: 2 data rows \(daily\) in the text block/);
    });

    it('writes one row per month for granularity=monthly', async () => {
      server = await startTestServer({ routes: routes(), now: NOW });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_764_879,
        toHeight: 5_767_496,
        granularity: 'monthly',
        output: 'csv',
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        `${BUCKET_HEADER}\n2026-09,20,662.574177,662574177,9,461.240390,461240390,11,201.333787,201333787,0,0.000000,0,11,9,2\n`,
      );
      expect(result.structuredContent?.csv).toBe(result.text);
      expect(outputSchema?.safeParse(result.structuredContent).success).toBe(true);
    });

    it('writes one row per receipt with local times, empty without a zone', async () => {
      server = await startTestServer({
        routes: routes(),
        now: NOW,
        env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
      });
      const local = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_764_879,
        toHeight: 5_767_496,
        granularity: 'receipt',
        output: 'csv',
      });
      expect(local.isError).toBe(false);
      const lines = local.text.split('\n');
      expect(lines[0]).toBe('height,timestamp_utc,timestamp_local,kind,xym,raw');
      expect(lines[1]).toBe(
        '5764879,2026-09-10T13:07:19.149Z,2026-09-10T22:07:19+09:00,harvester,51.247120,51247120',
      );
      expect(lines[2]).toMatch(
        /^5764879,2026-09-10T13:07:19\.149Z,2026-09-10T22:07:19\+09:00,beneficiary,/,
      );
      expect(lines).toHaveLength(22); // header + 20 receipts + trailing empty string
      expect(local.structuredContent?.csv).toBe(local.text);
      await server.close();

      server = await startTestServer({ routes: routes(), now: NOW });
      const utc = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_764_879,
        toHeight: 5_767_496,
        granularity: 'receipt',
        output: 'csv',
      });
      expect(utc.text.split('\n')[1]).toBe(
        '5764879,2026-09-10T13:07:19.149Z,,harvester,51.247120,51247120',
      );
    });

    it('applies the receipt cap of format to the CSV rows', async () => {
      const pages = routes({
        'GET /statements/transaction': statementsRoute((pageNumber) =>
          pageNumber <= 2 ? syntheticStatements(5_764_879 + (pageNumber - 1) * 100, 100) : [],
        ),
      });
      server = await startTestServer({ routes: pages, now: NOW });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_764_879,
        toHeight: 5_765_078,
        granularity: 'receipt',
        output: 'csv',
      });
      expect(result.isError).toBe(false);
      expect(result.text.split('\n')).toHaveLength(52); // header + 50 + trailing
      expect(result.structuredContent).toMatchObject({
        receiptsListed: 50,
        truncated: true,
        truncationReasons: ['receiptList'],
      });
      expect(result.structuredContent?.summary).toMatch(/lists 50 of 400 receipts/);
      expect(result.structuredContent?.summary).toMatch(/CSV: 50 data rows \(receipt\)/);
    });
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

  describe('chunked statement fetching', () => {
    /** 90 and 7 days at the fixture's 30 s target block time. */
    const CHUNK = 259_200;
    const MIN_CHUNK = 20_160;
    /** Raw amounts the fixture row pays to the account: harvester + beneficiary. */
    const ROW_HARVESTER = 51_247_120n;
    const ROW_BENEFICIARY = 18_302_542n;

    type Row = ReturnType<typeof syntheticStatements>[number];

    /** One statement at `height`, every receipt amount multiplied by `factor` (ratios unchanged). */
    function statementAt(height: number, factor = 1): Row {
      const row = syntheticStatements(height, 1)[0];
      if (!row) throw new Error('fixture row missing');
      const receipts = (row.statement as unknown as { receipts: Array<{ amount: string }> })
        .receipts;
      return {
        ...row,
        statement: {
          ...row.statement,
          receipts: receipts.map((r) => ({
            ...r,
            amount: (BigInt(r.amount) * BigInt(factor)).toString(),
          })),
        },
      } as Row;
    }

    function timeoutError(): Error {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      return err;
    }

    /** Serves `all` like the node: filtered by the requested heights, ascending, 100 per page. */
    function pagedStatements(
      all: Row[],
      timesOut: (widthBlocks: number, pageNumber: number) => boolean = () => false,
    ) {
      const sorted = [...all].sort(
        (a, b) => Number(a.statement.height) - Number(b.statement.height),
      );
      return statementsRoute((pageNumber, from, to) => {
        if (timesOut(to - from + 1, pageNumber)) throw timeoutError();
        return sorted
          .filter((r) => Number(r.statement.height) >= from && Number(r.statement.height) <= to)
          .slice((pageNumber - 1) * 100, pageNumber * 100);
      });
    }

    function statementRequests(s: TestServer) {
      return s.requests
        .filter((u) => u.pathname === '/statements/transaction')
        .map((u) => ({
          fromHeight: Number(u.searchParams.get('fromHeight')),
          toHeight: Number(u.searchParams.get('toHeight')),
          pageNumber: Number(u.searchParams.get('pageNumber')),
        }));
    }

    it('keeps a range of up to about 90 days in one query and reports how it was read', async () => {
      server = await startTestServer({ routes: routes(), now: NOW });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_764_879,
        toHeight: 5_767_496,
      });
      expect(result.isError).toBe(false);
      expect(statementRequests(server)).toEqual([
        { fromHeight: 5_764_879, toHeight: 5_767_496, pageNumber: 1 },
      ]);
      expect(result.structuredContent).toMatchObject({
        pagesFetched: 1,
        fetch: { chunks: 1, chunkBlocks: CHUNK, splitRetries: 0, pagesFetched: 1 },
      });
      const notes = (result.structuredContent as { notes: string[] }).notes;
      expect(notes.join(' ')).toMatch(/chunks of about 90 days \(259,200 blocks\)/);
      expect(result.structuredContent?.summary).not.toMatch(/timed out/);
    });

    it('counts receipts on chunk boundaries exactly once', async () => {
      const FROM = 5_000_000;
      const TO = 5_700_000;
      const inside = [
        FROM,
        FROM + CHUNK - 1,
        FROM + CHUNK,
        FROM + 2 * CHUNK - 1,
        FROM + 2 * CHUNK,
        TO,
      ];
      const all = [...inside, FROM - 1, TO + 1].map((h) => statementAt(h));
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': pagedStatements(all) }),
        now: NOW,
      });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: FROM,
        toHeight: TO,
        granularity: 'receipt',
        output: 'csv',
      });
      expect(result.isError).toBe(false);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(outputSchema?.safeParse(sc).success).toBe(true);
      expect(sc).toMatchObject({
        totals: {
          receipts: 12,
          raw: '417297972',
          xym: '417.297972',
          receiptsHarvester: 6,
          rawHarvester: '307482720',
          receiptsBeneficiary: 6,
          rawBeneficiary: '109815252',
          receiptsUnknown: 0,
        },
        statementsFetched: 6,
        pagesFetched: 3,
        fetch: { chunks: 3, chunkBlocks: CHUNK, splitRetries: 0, pagesFetched: 3 },
        truncated: false,
      });
      // Requests: the three consecutive chunks, ascending, page numbers restarting at 1.
      expect(statementRequests(server)).toEqual([
        { fromHeight: FROM, toHeight: FROM + CHUNK - 1, pageNumber: 1 },
        { fromHeight: FROM + CHUNK, toHeight: FROM + 2 * CHUNK - 1, pageNumber: 1 },
        { fromHeight: FROM + 2 * CHUNK, toHeight: TO, pageNumber: 1 },
      ]);
      // Rows stay in ascending height order, harvester before beneficiary, in JSON and CSV.
      const receipts = (sc as { receipts: Array<{ height: number; kind: string }> }).receipts;
      expect(receipts.map((r) => r.height)).toEqual(inside.flatMap((h) => [h, h]));
      expect(receipts.slice(0, 2).map((r) => r.kind)).toEqual(['harvester', 'beneficiary']);
      const csvHeights = result.text
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((line) => Number(line.split(',')[0]));
      expect(csvHeights).toEqual(inside.flatMap((h) => [h, h]));
      expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    });

    it('restarts the page number in every chunk', async () => {
      const FROM = 5_000_000;
      const TO = FROM + 2 * CHUNK - 1;
      const all = [...syntheticStatements(FROM + 10, 150), ...syntheticStatements(FROM + CHUNK, 3)];
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': pagedStatements(all) }),
        now: NOW,
      });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: FROM,
        toHeight: TO,
        granularity: 'monthly',
      });
      expect(result.isError).toBe(false);
      expect(statementRequests(server)).toEqual([
        { fromHeight: FROM, toHeight: FROM + CHUNK - 1, pageNumber: 1 },
        { fromHeight: FROM, toHeight: FROM + CHUNK - 1, pageNumber: 2 },
        { fromHeight: FROM + CHUNK, toHeight: TO, pageNumber: 1 },
      ]);
      expect(result.structuredContent).toMatchObject({
        totals: { receipts: 306, raw: (153n * (ROW_HARVESTER + ROW_BENEFICIARY)).toString() },
        statementsFetched: 153,
        fetch: { chunks: 2, splitRetries: 0, pagesFetched: 3 },
      });
    });

    it('halves a chunk whose first page times out, and a year equals its two halves', async () => {
      const FROM = 4_700_000;
      const YEAR = 1_051_200;
      const TO = FROM + YEAR - 1;
      const MID = FROM + YEAR / 2;
      const heights = new Set<number>([FROM, MID - 1, MID, TO]);
      for (let h = FROM + 4_001; h <= TO; h += 9_973) heights.add(h);
      const all = [...heights].map((h, i) => statementAt(h, (i % 7) + 1));
      // The node only answers a first page in time when the range is at most about 45 days wide.
      const route = pagedStatements(
        all,
        (width, pageNumber) => pageNumber === 1 && width > CHUNK / 2,
      );
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': route }),
        now: NOW,
      });
      const call = async (fromHeight: number, toHeight: number) => {
        const r = await server?.callTool('symbol_harvesting_income', {
          account: ADDRESS,
          fromHeight,
          toHeight,
          granularity: 'monthly',
        });
        expect(r?.isError).toBe(false);
        expect(outputSchema?.safeParse(r?.structuredContent).success).toBe(true);
        return r?.structuredContent as {
          summary: string;
          totals: Record<string, string | number>;
          monthly: Array<{ month: string; raw: string }>;
          fetch: { chunks: number; splitRetries: number; pagesFetched: number };
          truncated: boolean;
        };
      };
      const year = await call(FROM, TO);
      const first = await call(FROM, MID - 1);
      const second = await call(MID, TO);

      for (const key of ['raw', 'rawHarvester', 'rawBeneficiary', 'rawUnknown']) {
        expect(BigInt(year.totals[key] as string)).toBe(
          BigInt(first.totals[key] as string) + BigInt(second.totals[key] as string),
        );
      }
      for (const key of ['receipts', 'receiptsHarvester', 'receiptsBeneficiary']) {
        expect(year.totals[key]).toBe(
          (first.totals[key] as number) + (second.totals[key] as number),
        );
      }
      expect(year.totals.receipts).toBe(heights.size * 2);
      expect(BigInt(year.totals.raw as string)).toBe(
        year.monthly.reduce((sum, m) => sum + BigInt(m.raw), 0n),
      );
      expect(year.truncated).toBe(false);
      // 259,200 timed out once; the rest of the year was read in 129,600-block chunks.
      expect(year.fetch).toEqual({
        chunks: 9,
        chunkBlocks: CHUNK,
        splitRetries: 1,
        pagesFetched: 9,
      });
      expect(first.fetch.splitRetries).toBeGreaterThanOrEqual(1);
      expect(year.summary.split('\n').at(-1)).toBe(
        '(the node timed out on 1 wide query; retried with smaller chunks)',
      );
      expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    });

    it('fails with the height range and the timeout when even the smallest chunk times out', async () => {
      const route = pagedStatements([], () => true);
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': route }),
        now: NOW,
      });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_000_000,
        toHeight: 5_299_999,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(
        /did not answer \/statements\/transaction for heights 5,000,000-5,020,159 \(20,160 blocks\) within 10000 ms/,
      );
      expect(result.text).toMatch(/about 7 days/);
      expect(result.text).toMatch(/narrow the range with fromHeight\/toHeight/);
      expect(result.text).toMatch(/raise SYMBOL_REQUEST_TIMEOUT_MS \(currently 10000\)/);
      expect(result.text).not.toMatch(/at .*\.ts:\d+/);
      // 259,200 -> 129,600 -> 64,800 -> 32,400 -> 20,160, always from the same height.
      expect(statementRequests(server)).toEqual(
        [CHUNK, 129_600, 64_800, 32_400, MIN_CHUNK].map((length) => ({
          fromHeight: 5_000_000,
          toHeight: 5_000_000 + length - 1,
          pageNumber: 1,
        })),
      );
    });

    it('does not retry a timeout on a later page', async () => {
      const route = pagedStatements(
        syntheticStatements(5_000_000, 150),
        (_width, pageNumber) => pageNumber === 2,
      );
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': route }),
        now: NOW,
      });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_000_000,
        toHeight: 5_700_000,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/did not answer .* within 10000 ms/);
      expect(result.text).not.toMatch(/even after shrinking/);
      expect(statementRequests(server)).toHaveLength(2);
    });

    it('does not retry other node errors', async () => {
      server = await startTestServer({
        routes: routes({
          'GET /statements/transaction': () => jsonResponse({ code: 'InternalError' }, 500),
        }),
        now: NOW,
      });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_000_000,
        toHeight: 5_700_000,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/answered HTTP 500/);
      expect(statementRequests(server)).toHaveLength(1);
    });

    it('counts the page limit across chunks', async () => {
      // Every chunk has 120 full pages, then an empty one.
      const route = statementsRoute((pageNumber, from) =>
        pageNumber <= 120 ? syntheticStatements(from + (pageNumber - 1) * 100, 100) : [],
      );
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': route }),
        now: NOW,
      });
      const result = await server.callTool('symbol_harvesting_income', {
        account: ADDRESS,
        fromHeight: 5_000_000,
        toHeight: 5_700_000,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        pagesFetched: 200,
        statementsFetched: 19_900,
        fetch: { chunks: 1, splitRetries: 0, pagesFetched: 200 },
        truncated: true,
        truncationReasons: ['pageLimit'],
      });
      expect(result.structuredContent?.summary).toMatch(
        /Narrow the period or split it with fromHeight\/toHeight/,
      );
      const requests = statementRequests(server);
      expect(requests).toHaveLength(200);
      expect(requests.filter((r) => r.fromHeight === 5_000_000)).toHaveLength(121);
      expect(requests.filter((r) => r.fromHeight === 5_000_000 + CHUNK)).toHaveLength(79);
    });
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
    expect(result.structuredContent?.summary).toMatch(
      /No harvest receipts in this period\. Check that the period is not before its first harvested block, and use symbol_delegation_diagnose to see whether its harvesting works\./,
    );
    expect(result.structuredContent?.summary).not.toMatch(/symbol_harvesting_status/);
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
        account: 'Not an account',
        fromHeight: 1,
        toHeight: 2,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/not a valid Symbol account identifier/);
      expect(server.requests.some((u) => u.pathname === '/statements/transaction')).toBe(false);
    });
  });
});
