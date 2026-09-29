import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_BLOCK_TIME,
  fixture,
  jsonResponse,
  mainnetRoutes,
  startTestServer,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('symbol_node_status', () => {
  it('reports a healthy, synced mainnet node', async () => {
    // Fixture block timestamp is 2026-09-10T03:01:38.808Z; pretend it is 60s later.
    server = await startTestServer({
      now: new Date(FIXTURE_BLOCK_TIME.getTime() + 60_000),
      env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      node: {
        friendlyName: 'fixture-node',
        host: 'mainnet-node.example',
        port: 7900,
        roles: ['Peer', 'API', 'Voting'],
        rolesRaw: 7,
        version: '1.0.3.9',
        versionRaw: 16_777_993,
        publicKey: 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E',
        nodePublicKey: 'CEF91B106670BC3FDD3614D8B9E816DAA3286817F79A99F902BDC9CD73EF3568',
      },
      network: { name: 'mainnet', identifier: 104, matchesConfiguredNetwork: true },
      health: { apiNode: 'up', db: 'up', healthy: true },
      chain: { height: 5_763_675, finalizedHeight: 5_763_656, finalizationEpoch: 4004 },
      peers: { count: 6 },
      sync: {
        latestBlockTime: { utc: '2026-09-10T03:01:38.808Z', local: '2026-09-10T12:01:38+09:00' },
        ageSeconds: 60,
        synced: true,
        thresholdSeconds: 300,
      },
      warnings: [],
    });
    expect(result.structuredContent?.summary).toMatch(/Synced/);
    expect(result.structuredContent?.summary).toMatch(/1\.0\.3\.9/);
  });

  it('flags a stalled node when the latest block is older than 10 block times (5 minutes on mainnet)', async () => {
    server = await startTestServer({ now: new Date(FIXTURE_BLOCK_TIME.getTime() + 30 * 60_000) });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    const sync = result.structuredContent?.sync as { synced: boolean; ageSeconds: number };
    expect(sync.synced).toBe(false);
    expect(sync.ageSeconds).toBeGreaterThan(300);
    expect(result.structuredContent?.warnings).toHaveLength(1);
    expect(result.structuredContent?.summary).toMatch(/NOT synced/);
  });

  it('keeps the mainnet boundary at 300 s: synced at 300, not synced at 301', async () => {
    for (const [ageSeconds, synced] of [
      [300, true],
      [301, false],
    ] as const) {
      server = await startTestServer({
        now: new Date(FIXTURE_BLOCK_TIME.getTime() + ageSeconds * 1000),
      });
      const result = await server.callTool('symbol_node_status');
      expect(result.structuredContent?.sync).toMatchObject({
        ageSeconds,
        synced,
        thresholdSeconds: 300,
      });
      expect(result.structuredContent?.summary).toContain(
        synced
          ? `Synced: latest block ${ageSeconds}s old.`
          : `NOT synced: latest block ${ageSeconds}s old (threshold 300s).`,
      );
      await server.close();
      server = undefined;
    }
  });

  it('derives the sync threshold from the block time of the network', async () => {
    const properties = fixture<{ chain: Record<string, unknown> }>(
      'mainnet/network-properties.json',
    );
    // 200 s: synced at a 30 s block time (300 s), not at 15 s (150 s).
    server = await startTestServer({
      now: new Date(FIXTURE_BLOCK_TIME.getTime() + 200_000),
      routes: {
        ...mainnetRoutes(),
        'GET /network/properties': {
          ...properties,
          chain: { ...properties.chain, blockGenerationTargetTime: '15s' },
        },
      },
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.sync).toMatchObject({
      ageSeconds: 200,
      synced: false,
      thresholdSeconds: 150,
    });
    expect(result.structuredContent?.warnings).toEqual([
      'Latest block is 200 seconds old (threshold 150s); the node appears to be behind or stalled.',
    ]);
  });

  it('reports unhealthy api/db and sanitizes the friendly name', async () => {
    const info = {
      ...fixture<Record<string, unknown>>('mainnet/node-info.json'),
      // NUL and RIGHT-TO-LEFT OVERRIDE written as escapes so git keeps the file as text.
      friendlyName: 'fix\u0000ture-node\u202E',
    };
    server = await startTestServer({
      now: new Date(FIXTURE_BLOCK_TIME.getTime() + 60_000),
      routes: {
        ...mainnetRoutes(),
        'GET /node/info': info,
        'GET /node/health': { status: { apiNode: 'up', db: 'down' } },
      },
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.node).toMatchObject({ friendlyName: 'fixture-node' });
    expect(result.structuredContent?.health).toEqual({ apiNode: 'up', db: 'down', healthy: false });
    expect(result.structuredContent?.warnings).toEqual([expect.stringMatching(/db=down/)]);
  });

  it('reads the 503 body of /node/health instead of failing the call', async () => {
    server = await startTestServer({
      now: new Date(FIXTURE_BLOCK_TIME.getTime() + 60_000),
      routes: {
        ...mainnetRoutes(),
        'GET /node/health': () => jsonResponse({ status: { apiNode: 'down', db: 'up' } }, 503),
      },
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.health).toEqual({ apiNode: 'down', db: 'up', healthy: false });
    expect(result.structuredContent?.warnings).toEqual([expect.stringMatching(/apiNode=down/)]);
  });
});
