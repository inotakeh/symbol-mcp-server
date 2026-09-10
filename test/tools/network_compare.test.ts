import { afterEach, describe, expect, it } from 'vitest';
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

const REF_A = 'https://reference-a.test:3001';
const REF_B = 'https://reference-b.test:3001';

/** Routes whose /chain/info and /node/info answers depend on the host being asked. */
function perHostRoutes(
  overrides: Record<
    string,
    { height?: string; finalized?: string; seed?: string; fail?: 'all' | 'chain' }
  >,
): Routes {
  const chain = fixture<{ height: string; latestFinalizedBlock: { height: string } }>(
    'mainnet/chain-info.json',
  );
  const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
  return {
    ...mainnetRoutes(),
    'GET /chain/info': (_req: Request, url: URL) => {
      const o = overrides[url.host] ?? {};
      if (o.fail) return jsonResponse({}, 503);
      return jsonResponse({
        ...chain,
        height: o.height ?? chain.height,
        latestFinalizedBlock: {
          ...chain.latestFinalizedBlock,
          height: o.finalized ?? chain.latestFinalizedBlock.height,
        },
      });
    },
    'GET /node/info': (_req: Request, url: URL) => {
      const o = overrides[url.host] ?? {};
      if (o.fail === 'all') return jsonResponse({}, 503);
      return jsonResponse({
        ...info,
        networkGenerationHashSeed: o.seed ?? info.networkGenerationHashSeed,
      });
    },
  };
}

describe('symbol_network_compare', () => {
  it('explains what to configure when no reference nodes are set (not an error)', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_network_compare');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      referenceNodesConfigured: false,
      nodes: [
        {
          role: 'own',
          host: TEST_NODE_HOST,
          reachable: true,
          height: 5_763_675,
          heightBehindBest: 0,
        },
      ],
      best: { height: 5_763_675, finalizedHeight: 5_763_656 },
      own: { heightBehindBest: 0, lagging: false, finalizationLagging: false },
      thresholdBlocks: 10,
    });
    expect(result.structuredContent?.summary).toMatch(/No reference nodes are configured/);
    expect(result.structuredContent?.summary).toMatch(/SYMBOL_REFERENCE_NODES/);
    expect(result.structuredContent?.summary).toMatch(/nodewatch\.symbol\.tools/);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('compares against the configured reference nodes only and flags lag', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: `${REF_A},${REF_B}` },
      routes: perHostRoutes({
        'reference-a.test:3001': { height: '5763700', finalized: '5763680' },
        'reference-b.test:3001': { height: '5763690' },
      }),
    });
    const result = await server.callTool('symbol_network_compare');
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.referenceNodesConfigured).toBe(true);
    expect(sc.best).toEqual({ height: 5_763_700, finalizedHeight: 5_763_680 });
    expect(sc.own).toEqual({
      heightBehindBest: 25,
      finalizedBehindBest: 24,
      lagging: true,
      finalizationLagging: true,
    });
    const nodes = sc.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => [n.role, n.host, n.height, n.heightBehindBest])).toEqual([
      ['own', TEST_NODE_HOST, 5_763_675, 25],
      ['reference', 'reference-a.test:3001', 5_763_700, 0],
      ['reference', 'reference-b.test:3001', 5_763_690, 10],
    ]);
    expect(sc.summary).toMatch(/LAGGING by 25 blocks/);
    expect(sc.summary).toMatch(/- reference-a\.test:3001: height 5,763,700 \(best\)/);
    // Exactly the configured hosts, nothing else.
    const hosts = new Set(server.requests.map((u) => u.host));
    expect(hosts).toEqual(
      new Set([TEST_NODE_HOST, 'reference-a.test:3001', 'reference-b.test:3001']),
    );
    const refPaths = server.requests
      .filter((u) => u.host === 'reference-a.test:3001')
      .map((u) => u.pathname)
      .sort();
    expect(refPaths).toEqual(['/chain/info', '/node/info']);
  });

  it('reports an unreachable reference and excludes a node on another network', async () => {
    const testnetSeed = '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4';
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: `${REF_A},${REF_B}` },
      routes: perHostRoutes({
        'reference-a.test:3001': { fail: 'all' },
        'reference-b.test:3001': { height: '9999999', seed: testnetSeed },
      }),
    });
    const result = await server.callTool('symbol_network_compare');
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    const nodes = sc.nodes as Array<Record<string, unknown>>;
    expect(nodes[1]).toMatchObject({
      reachable: false,
      height: null,
      error: expect.stringMatching(/http/),
    });
    expect(nodes[2]).toMatchObject({ reachable: true, network: 'testnet', sameNetwork: false });
    // The wrong-network node does not raise the bar.
    expect(sc.best).toEqual({ height: 5_763_675, finalizedHeight: 5_763_656 });
    expect(sc.own).toMatchObject({ heightBehindBest: 0, lagging: false });
    expect(sc.summary).toMatch(/in sync/);
    expect(sc.summary).toMatch(/reference-a\.test:3001: unreachable/);
    expect(sc.summary).toMatch(/WRONG NETWORK: testnet/);
  });

  it('survives an unreachable own node', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: REF_A },
      // Startup network verification must still succeed, so only /chain/info fails.
      routes: perHostRoutes({ [TEST_NODE_HOST]: { fail: 'chain' } }),
    });
    const result = await server.callTool('symbol_network_compare');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.own).toMatchObject({ heightBehindBest: null, lagging: false });
    expect(result.structuredContent?.summary).toMatch(/own node unreachable/);
  });
});
