import { afterEach, describe, expect, it } from 'vitest';
import {
  fixture,
  jsonResponse,
  mainnetRoutes,
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

describe('symbol_mosaic_get', () => {
  it('describes the currency mosaic by hex id', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_mosaic_get', { mosaic: '6bed913fa20223f8' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      id: '6BED913FA20223F8',
      alias: 'symbol.xym',
      supply: { amount: '7842928625.000000', raw: '7842928625000000' },
      divisibility: 6,
      flags: {
        supplyMutable: false,
        transferable: true,
        restrictable: false,
        revokable: false,
        raw: 2,
      },
      owner: expect.stringMatching(/^N[A-Z2-7]{38}$/),
      startHeight: 1,
      duration: {
        blocks: 0,
        unlimited: true,
        endHeight: null,
        remainingBlocks: null,
        expiresAt: null,
        expired: false,
        estimateNote: null,
      },
      revision: 1,
    });
    expect(result.structuredContent?.summary).toMatch(/symbol\.xym.*supply 7842928625\.000000/);
    expect(result.structuredContent?.summary).toMatch(/unlimited duration/);
    // No expiry estimate needed, so no block or chain lookups.
    expect(server.requests.some((u) => u.pathname.startsWith('/blocks/'))).toBe(false);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('resolves an alias name through the namespace', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_mosaic_get', { mosaic: 'Symbol.XYM' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.id).toBe('6BED913FA20223F8');
    const paths = server.requests.map((u) => u.pathname);
    expect(paths).toContain('/namespaces/E74B99BA41F4AFEE');
    expect(paths).toContain('/mosaics/6BED913FA20223F8');
  });

  it('estimates the expiry of a mosaic with a finite duration', async () => {
    const other = fixture<{ mosaic: Record<string, unknown> }>('mainnet/mosaic-other.json');
    other.mosaic.duration = '5000000';
    other.mosaic.flags = 15;
    server = await startTestServer({
      env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
      routes: { ...mainnetRoutes(), 'GET /mosaics/66BAE04E8758599E': other },
    });
    const result = await server.callTool('symbol_mosaic_get', { mosaic: '66BAE04E8758599E' });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.flags).toEqual({
      supplyMutable: true,
      transferable: true,
      restrictable: true,
      revokable: true,
      raw: 15,
    });
    expect(sc.alias).toBeNull();
    // startHeight 1,000,000 + 5,000,000 = 6,000,000; current height 5,763,675 -> 236,325 blocks left
    const duration = sc.duration as Record<string, unknown>;
    expect(duration).toMatchObject({
      blocks: 5_000_000,
      unlimited: false,
      endHeight: 6_000_000,
      remainingBlocks: 236_325,
      expired: false,
    });
    expect(duration.remainingDays).toBe(82.1);
    const expiresAt = duration.expiresAt as { utc: string; local: string };
    expect(expiresAt.utc).toBe(new Date(TEST_NOW.getTime() + 236_325 * 30_030).toISOString());
    expect(expiresAt.local).toMatch(/\+09:00$/);
    expect(duration.estimateNote).toMatch(/30\.03s/);
    expect(sc.summary).toContain(`estimated ${expiresAt.local} (${expiresAt.utc})`);
  });

  it('reports an expired mosaic', async () => {
    const other = fixture<{ mosaic: Record<string, unknown> }>('mainnet/mosaic-other.json');
    other.mosaic.duration = '100';
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /mosaics/66BAE04E8758599E': other },
    });
    const result = await server.callTool('symbol_mosaic_get', { mosaic: '66BAE04E8758599E' });
    expect(result.structuredContent?.duration).toMatchObject({
      endHeight: 1_000_100,
      expired: true,
      remainingBlocks: null,
    });
    expect(result.structuredContent?.summary).toMatch(/expired at height 1,000,100/);
  });

  it('gives hinted errors for unknown ids, non-mosaic aliases and bad input', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        'GET /namespaces/A95F1F8A96159516': fixture('mainnet/namespace-symbol.json'),
      },
    });
    const unknown = await server.callTool('symbol_mosaic_get', { mosaic: '0123456789ABCDEF' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/does not exist on mainnet/);

    const notAlias = await server.callTool('symbol_mosaic_get', { mosaic: 'symbol' });
    expect(notAlias.isError).toBe(true);
    expect(notAlias.text).toMatch(/not an alias for a mosaic/);
    expect(notAlias.text).toMatch(/symbol_namespace_get/);

    const bad = await server.callTool('symbol_mosaic_get', { mosaic: 'Not A Mosaic!' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not a namespace name or id/);
  });

  it('surfaces node failures', async () => {
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /mosaics/6BED913FA20223F8': () => jsonResponse({}, 503) },
    });
    const result = await server.callTool('symbol_mosaic_get', { mosaic: '6BED913FA20223F8' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/HTTP 503/);
  });
});
