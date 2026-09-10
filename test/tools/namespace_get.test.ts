import { afterEach, describe, expect, it } from 'vitest';
import {
  fixture,
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

describe('symbol_namespace_get', () => {
  it('describes symbol.xym by name (derived id, resolved level names, mosaic alias)', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_namespace_get', { namespace: 'symbol.xym' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      id: 'E74B99BA41F4AFEE',
      name: 'symbol.xym',
      registrationType: 'sub',
      depth: 2,
      levels: [
        { id: 'A95F1F8A96159516', name: 'symbol' },
        { id: 'E74B99BA41F4AFEE', name: 'symbol.xym' },
      ],
      parentId: 'A95F1F8A96159516',
      owner: expect.stringMatching(/^N[A-Z2-7]{38}$/),
      alias: { type: 'mosaic', mosaicId: '6BED913FA20223F8', address: null },
      active: true,
      startHeight: 1,
      endHeight: null,
      unlimited: true,
      remainingBlocks: null,
      expired: false,
      expiresAt: null,
      estimateNote: null,
    });
    expect(result.structuredContent?.summary).toMatch(
      /Namespace symbol\.xym \(E74B99BA41F4AFEE\) on mainnet: sub-namespace of A95F1F8A96159516/,
    );
    expect(result.structuredContent?.summary).toMatch(/alias for mosaic 6BED913FA20223F8/);
    expect(result.structuredContent?.summary).toMatch(/never expires/);
    const paths = server.requests.map((u) => u.pathname);
    expect(paths).toContain('/namespaces/E74B99BA41F4AFEE');
    expect(paths).toContain('/namespaces/names');
    expect(paths.some((p) => p.startsWith('/blocks/'))).toBe(false);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('describes the root namespace by hex id', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_namespace_get', { namespace: 'a95f1f8a96159516' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      id: 'A95F1F8A96159516',
      name: 'symbol',
      registrationType: 'root',
      depth: 1,
      parentId: null,
      alias: { type: 'none', mosaicId: null, address: null },
    });
    expect(result.structuredContent?.summary).toMatch(/root, depth 1, no alias/);
  });

  it('estimates expiry for a namespace with a finite end height and an address alias', async () => {
    const info = fixture<{ namespace: Record<string, unknown> }>('mainnet/namespace-symbol.json');
    info.namespace.endHeight = '6000000';
    info.namespace.alias = { type: 2, address: '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53' };
    server = await startTestServer({
      env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
      routes: { ...mainnetRoutes(), 'GET /namespaces/A95F1F8A96159516': info },
    });
    const result = await server.callTool('symbol_namespace_get', { namespace: 'symbol' });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.alias).toEqual({
      type: 'address',
      mosaicId: null,
      address: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY',
    });
    expect(sc).toMatchObject({
      unlimited: false,
      endHeight: 6_000_000,
      remainingBlocks: 236_325,
      remainingDays: 82.1,
      expired: false,
    });
    const expiresAt = sc.expiresAt as { utc: string; local: string };
    expect(expiresAt.utc).toBe(new Date(TEST_NOW.getTime() + 236_325 * 30_030).toISOString());
    expect(sc.summary).toContain(`estimated ${expiresAt.local} (${expiresAt.utc})`);
    expect(sc.estimateNote).toMatch(/Sub-namespaces expire with their root/);
  });

  it('reports not found and invalid names with hints', async () => {
    server = await startTestServer();
    const missing = await server.callTool('symbol_namespace_get', {
      namespace: 'nonexistent.name',
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(
      /Namespace "nonexistent.name" \(id [0-9A-F]{16}\) does not exist on mainnet/,
    );

    const bad = await server.callTool('symbol_namespace_get', { namespace: 'a.b.c.d' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/up to 3 dot-separated levels/);
    expect(server.requests.filter((u) => u.pathname.startsWith('/namespaces/'))).toHaveLength(1);
  });
});
