import { afterEach, describe, expect, it } from 'vitest';
import { nodeHealthTool } from '../../src/tools/symbol_node_health.js';
import {
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
];

type Check = { id: string; status: string; detail: string; hint: string | null };

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
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
    expect(JSON.parse(result.text)).toEqual(sc);
    expect(nodeHealthTool.outputSchema.safeParse(sc).success).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of ['/node/health', '/node/storage', '/node/time', '/chain/info', '/node/info']) {
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

  it('never contacts the reference nodes', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: 'https://reference-a.test:3001' },
    });
    await server.callTool('symbol_node_health');
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });
});
