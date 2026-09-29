import { afterEach, describe, expect, it } from 'vitest';
import { nodeHealthTool } from '../../src/tools/symbol_node_health.js';
import {
  FIXTURE_BLOCK_TIME,
  fixture,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  startTestServer,
  TEST_NODE_HOST,
  TEST_NOW,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const CHECK_IDS = [
  'api_node',
  'db',
  'storage_consistent',
  'clock_skew',
  'finalization_lag',
  'roles',
  'chain_tip_age',
];

type Check = { id: string; status: string; detail: string; hint: string | null };

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

/** Height of the chain-info fixture, and the path of its latest block. */
const HEIGHT = 5_763_675;
const LATEST_BLOCK = `GET /blocks/${HEIGHT}`;

/**
 * The fixture's latest block with its timestamp moved so that it is `ageMs` old at TEST_NOW. The
 * clock is left alone, so clock_skew stays ok and only the age of the chain tip changes.
 */
function latestBlockAged(ageMs: number) {
  const block = fixture<{ block: { timestamp: string } }>(`mainnet/block-${HEIGHT}.json`);
  const shift = TEST_NOW.getTime() - ageMs - FIXTURE_BLOCK_TIME.getTime();
  return {
    ...block,
    block: { ...block.block, timestamp: String(Number(block.block.timestamp) + shift) },
  };
}

function chainWithFinalized(finalized: number) {
  const chain = fixture<{ latestFinalizedBlock: { height: string } }>('mainnet/chain-info.json');
  return {
    ...chain,
    latestFinalizedBlock: { ...chain.latestFinalizedBlock, height: String(finalized) },
  };
}

function checksOf(result: { structuredContent?: Record<string, unknown> | undefined }): Check[] {
  return result.structuredContent?.checks as Check[];
}

describe('symbol_node_health', () => {
  it('reports a healthy node from the fixtures (skew -1 s, lag 19 blocks)', async () => {
    server = await startTestServer({ env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' } });
    const result = await server.callTool('symbol_node_health');
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.verdict).toBe('healthy');
    expect(checksOf(result).map((c) => [c.id, c.status])).toEqual(
      CHECK_IDS.map((id) => [id, 'ok']),
    );
    // concise: no hints on ok checks
    expect(checksOf(result).every((c) => c.hint === null)).toBe(true);
    expect(sc).toMatchObject({
      network: 'mainnet',
      node: { version: '1.0.3.9', roles: ['Peer', 'API', 'Voting'] },
      storage: { numBlocks: 5_763_675, numTransactions: 24_000_000, numAccounts: 1_100_000 },
      chain: { height: 5_763_675, finalizedHeight: 5_763_656, finalizationEpoch: 4004 },
      time: {
        nodeTime: { utc: '2026-09-10T03:04:59.000Z', local: '2026-09-10T12:04:59+09:00' },
        localTime: { utc: TEST_NOW.toISOString() },
        skewMs: -1000,
      },
    });
    expect(sc.summary).toMatch(/^node health: healthy \(node\.test:3001, mainnet\)\.$/);
    expect(checksOf(result)[2]?.detail).toMatch(/tolerance 2/);
    expect(checksOf(result)[4]?.detail).toMatch(/19 blocks \(about 9\.5 min\)/);
    expect(checksOf(result)[5]?.detail).toMatch(/a voting node/);
    // The fixture block is 201.192 s older than TEST_NOW; mainnet's 30 s block time gives 300/900.
    expect(checksOf(result)[6]?.detail).toBe(
      'Latest block (height 5,763,675) is 201 s old (about 3.4 min; warn above 300 s, fail above 900 s).',
    );
    expect(JSON.parse(result.text)).toEqual(sc);
    expect(nodeHealthTool.outputSchema.safeParse(sc).success).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of [
      '/node/health',
      '/node/storage',
      '/node/time',
      '/chain/info',
      '/node/info',
      `/blocks/${HEIGHT}`,
    ]) {
      expect(paths).toContain(p);
    }
  });

  it('is degraded on storage drift, clock skew and finalization lag warnings', async () => {
    server = await startTestServer({
      now: new Date(TEST_NOW.getTime() + 20_000), // fixture node time is TEST_NOW - 1 s -> skew -21 s
      routes: routes({
        'GET /node/storage': { numBlocks: 5_763_672, numTransactions: 1, numAccounts: 1 },
        'GET /chain/info': chainWithFinalized(5_763_675 - 800),
      }),
    });
    const result = await server.callTool('symbol_node_health', { format: 'detailed' });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.verdict).toBe('degraded');
    const byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('storage_consistent')).toMatchObject({ status: 'warn' });
    expect(byId.get('clock_skew')).toMatchObject({ status: 'warn' });
    expect(byId.get('clock_skew')?.detail).toMatch(/21,000 ms behind/);
    expect(byId.get('finalization_lag')).toMatchObject({ status: 'warn' });
    expect(byId.get('finalization_lag')?.detail).toMatch(/800 blocks \(about 400 min\)/);
    // detailed: hints everywhere
    expect(checksOf(result).every((c) => typeof c.hint === 'string')).toBe(true);
    expect(sc.summary).toMatch(/^node health: degraded/);
    expect(sc.summary).toMatch(/- storage_consistent warn/);
    expect(sc.summary).toMatch(/- clock_skew warn/);
    expect(sc.summary).toMatch(/- finalization_lag warn/);
    expect((sc.time as { skewMs: number }).skewMs).toBe(-21_000);
  });

  it('reads the body of a 503 /node/health answer and reports the down service', async () => {
    server = await startTestServer({
      routes: routes({
        'GET /node/health': () => jsonResponse({ status: { apiNode: 'up', db: 'down' } }, 503),
      }),
    });
    const result = await server.callTool('symbol_node_health');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('unhealthy');
    const byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('api_node')).toMatchObject({ status: 'ok' });
    expect(byId.get('db')).toMatchObject({ status: 'fail', detail: 'Database service is down.' });
    expect(byId.get('db')?.hint).toMatch(/MongoDB/);
    expect(result.structuredContent?.summary).toMatch(/^node health: unhealthy/);
    expect(result.structuredContent?.summary).toMatch(/- db fail/);
  });

  it('marks api_node and db as failed when /node/health itself cannot be reached', async () => {
    for (const handler of [
      () => {
        throw new TypeError('fetch failed');
      },
      () => jsonResponse({ code: 'Internal', message: 'boom' }, 500),
    ]) {
      server = await startTestServer({ routes: routes({ 'GET /node/health': handler }) });
      const result = await server.callTool('symbol_node_health');
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.verdict).toBe('unhealthy');
      const checks = checksOf(result);
      expect(checks.map((c) => [c.id, c.status])).toEqual([
        ['api_node', 'fail'],
        ['db', 'fail'],
        ['storage_consistent', 'ok'],
        ['clock_skew', 'ok'],
        ['finalization_lag', 'ok'],
        ['roles', 'ok'],
        ['chain_tip_age', 'ok'],
      ]);
      expect(checks[0]?.detail).toMatch(/did not answer \/node\/health \((unreachable|http 500)\)/);
      await server.close();
      server = undefined;
    }
  });

  it('treats a failed or empty /node/time as an unknown clock check (degraded)', async () => {
    server = await startTestServer({
      routes: routes({ 'GET /node/time': () => jsonResponse({}, 503) }),
    });
    let result = await server.callTool('symbol_node_health');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    let byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('clock_skew')).toMatchObject({ status: 'unknown' });
    expect(byId.get('clock_skew')?.detail).toMatch(/http 503/);
    expect(result.structuredContent?.time).toMatchObject({ nodeTime: null, skewMs: null });
    const time = result.structuredContent?.time as { localTime: { utc: string } };
    expect(time.localTime.utc).toBe(TEST_NOW.toISOString());
    expect(result.structuredContent?.summary).toMatch(/- clock_skew unknown/);
    await server.close();

    server = await startTestServer({
      routes: routes({ 'GET /node/time': { communicationTimestamps: {} } }),
    });
    result = await server.callTool('symbol_node_health');
    byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('clock_skew')).toMatchObject({ status: 'unknown' });
    expect(byId.get('clock_skew')?.detail).toMatch(/without a timestamp/);
    expect(nodeHealthTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('answers with what it has when /node/info, /node/storage or /chain/info fail', async () => {
    server = await startTestServer({
      routes: routes({
        'GET /node/storage': () => jsonResponse({}, 503),
        'GET /chain/info': () => jsonResponse({}, 503),
      }),
    });
    // The harness verifies the network at startup with /node/info, so fail it only afterwards.
    let result = await server.callTool('symbol_node_health');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    let byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('storage_consistent')).toMatchObject({ status: 'unknown' });
    expect(byId.get('finalization_lag')).toMatchObject({ status: 'unknown' });
    // Without the chain height there is no latest block to ask for.
    expect(byId.get('chain_tip_age')).toMatchObject({ status: 'unknown' });
    expect(byId.get('chain_tip_age')?.detail).toMatch(/did not answer \/chain\/info \(http 503\)/);
    expect(server.requests.some((u) => u.pathname.startsWith('/blocks/'))).toBe(false);
    expect(result.structuredContent).toMatchObject({ storage: null, chain: null });
    expect(nodeHealthTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    await server.close();

    let calls = 0;
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    server = await startTestServer({
      routes: routes({
        'GET /node/info': () => (calls++ === 0 ? jsonResponse(info) : jsonResponse({}, 503)),
      }),
    });
    result = await server.callTool('symbol_node_health');
    expect(result.isError).toBe(false);
    byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('roles')).toMatchObject({ status: 'unknown' });
    expect(result.structuredContent?.node).toBeNull();
    expect(result.structuredContent?.verdict).toBe('degraded');
  });

  it('fails the clock check at a whole block time of skew', async () => {
    server = await startTestServer({ now: new Date(TEST_NOW.getTime() + 31_000) });
    const result = await server.callTool('symbol_node_health');
    const byId = new Map(checksOf(result).map((c) => [c.id, c]));
    expect(byId.get('clock_skew')).toMatchObject({ status: 'fail' });
    expect(byId.get('clock_skew')?.hint).toMatch(/harvested blocks/);
    expect(result.structuredContent?.verdict).toBe('unhealthy');
  });

  it('grades the age of the latest block against 10 and 30 block times', async () => {
    const cases: Array<[number, string, string]> = [
      [300_000, 'ok', 'healthy'],
      [301_000, 'warn', 'degraded'],
      [900_000, 'warn', 'degraded'],
      [901_000, 'fail', 'unhealthy'],
    ];
    for (const [ageMs, status, verdict] of cases) {
      server = await startTestServer({
        routes: routes({ [LATEST_BLOCK]: latestBlockAged(ageMs) }),
      });
      const result = await server.callTool('symbol_node_health');
      expect(result.isError).toBe(false);
      const checks = checksOf(result);
      // Only the chain tip moved: the other six checks stay ok.
      expect(checks.map((c) => [c.id, c.status])).toEqual(
        CHECK_IDS.map((id) => [id, id === 'chain_tip_age' ? status : 'ok']),
      );
      expect(result.structuredContent?.verdict, `${ageMs} ms`).toBe(verdict);
      await server.close();
      server = undefined;
    }
  });

  it('reports a stalled node with the age, the thresholds and a hint', async () => {
    server = await startTestServer({
      routes: routes({ [LATEST_BLOCK]: latestBlockAged(2 * 3_600_000) }),
    });
    const result = await server.callTool('symbol_node_health');
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({ id: 'chain_tip_age', status: 'fail' });
    expect(tip?.detail).toBe(
      'Latest block (height 5,763,675) is 7,200 s old (about 2 h; warn above 300 s, fail above 900 s).',
    );
    expect(tip?.hint).toMatch(/^The node is not adding blocks: it has stalled or fallen behind/);
    expect(result.structuredContent?.summary).toBe(
      [
        'node health: unhealthy (node.test:3001, mainnet).',
        `- chain_tip_age fail: ${tip?.detail}`,
      ].join('\n'),
    );
  });

  it('gives no estimate under two minutes, and minutes, hours or days beyond', async () => {
    const cases: Array<[number, string]> = [
      // The usual age on a node that follows the chain.
      [45_000, 'is 45 s old (warn above 300 s, fail above 900 s).'],
      // Units are chosen after rounding: 119.95 min reads as 2 h, not 120 min.
      [7_197_000, 'is 7,197 s old (about 2 h; warn above 300 s, fail above 900 s).'],
      [3 * 86_400_000, 'is 259,200 s old (about 3 days; warn above 300 s, fail above 900 s).'],
      [
        100_000_000_000,
        'is 100,000,000 s old (about 1,157.4 days; warn above 300 s, fail above 900 s).',
      ],
    ];
    for (const [ageMs, text] of cases) {
      server = await startTestServer({
        routes: routes({ [LATEST_BLOCK]: latestBlockAged(ageMs) }),
      });
      const result = await server.callTool('symbol_node_health');
      expect(checksOf(result)[6]?.detail).toBe(`Latest block (height 5,763,675) ${text}`);
      await server.close();
      server = undefined;
    }
  });

  it('derives the chain tip thresholds from the block time of the network', async () => {
    const properties = fixture<{ chain: Record<string, unknown> }>(
      'mainnet/network-properties.json',
    );
    server = await startTestServer({
      routes: routes({
        'GET /network/properties': {
          ...properties,
          chain: { ...properties.chain, blockGenerationTargetTime: '15s' },
        },
        // 160 s: ok at 30 s (300 s), a warning at 15 s (150 s).
        [LATEST_BLOCK]: latestBlockAged(160_000),
      }),
    });
    const result = await server.callTool('symbol_node_health', { format: 'detailed' });
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({ id: 'chain_tip_age', status: 'warn' });
    expect(tip?.detail).toMatch(
      /is 160 s old \(about 2\.7 min; warn above 150 s, fail above 450 s\)/,
    );
  });

  it('does not count a latest block ahead of the local clock as old', async () => {
    server = await startTestServer({ routes: routes({ [LATEST_BLOCK]: latestBlockAged(-5_000) }) });
    const result = await server.callTool('symbol_node_health', { format: 'detailed' });
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({ id: 'chain_tip_age', status: 'ok' });
    expect(tip?.detail).toBe(
      "Latest block (height 5,763,675) is timestamped 5 s ahead of this machine's clock, so it is not old (warn above 300 s, fail above 900 s).",
    );
    expect(tip?.hint).toMatch(/^Thresholds are 10 and 30 times the 30-second target block time/);
  });

  it('treats a latest block it cannot fetch as an unknown chain tip (degraded)', async () => {
    server = await startTestServer({
      routes: routes({ [LATEST_BLOCK]: () => jsonResponse({}, 503) }),
    });
    const result = await server.callTool('symbol_node_health');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({
      id: 'chain_tip_age',
      status: 'unknown',
      detail: `${TEST_NODE_HOST} did not answer /blocks/${HEIGHT} (http 503).`,
      hint: 'Retry later; the other checks do not depend on it.',
    });
    expect(result.structuredContent?.chain).toMatchObject({ height: HEIGHT });
    expect(result.structuredContent?.summary).toMatch(/- chain_tip_age unknown/);
  });

  it('treats a block timestamp that is no valid time as an unknown chain tip, not an error', async () => {
    // Any digits pass the uint64 schema: beyond the last date JavaScript knows, and too long to be
    // a finite number.
    const block = fixture<{ block: Record<string, unknown> }>(`mainnet/block-${HEIGHT}.json`);
    for (const timestamp of ['9000000000000000', '9'.repeat(400)]) {
      server = await startTestServer({
        routes: routes({ [LATEST_BLOCK]: { ...block, block: { ...block.block, timestamp } } }),
      });
      const result = await server.callTool('symbol_node_health');
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.verdict).toBe('degraded');
      expect(checksOf(result).map((c) => [c.id, c.status])).toEqual(
        CHECK_IDS.map((id) => [id, id === 'chain_tip_age' ? 'unknown' : 'ok']),
      );
      expect(checksOf(result)[6]?.detail).toBe(
        `${TEST_NODE_HOST} answered /blocks/${HEIGHT} with a block timestamp that is not a valid time.`,
      );
      await server.close();
      server = undefined;
    }
  });

  it('never contacts the reference nodes', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: 'https://reference-a.test:3001' },
    });
    await server.callTool('symbol_node_health');
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });
});
