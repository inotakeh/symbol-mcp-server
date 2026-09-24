import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { versionDriftTool } from '../../src/tools/symbol_version_drift.js';
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
const TESTNET_SEED = '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4';
const V_1_0_3_7 = 16_777_991;
const V_1_0_3_8 = 16_777_992;
const V_1_0_3_9 = 16_777_993;
const V_1_0_4_0 = 16_778_240;

type Peer = Record<string, unknown>;

const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();

function peers(): Peer[] {
  return fixture<Peer[]>('mainnet/peers.json');
}

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

/** /node/info answers that depend on the host asked (the own node keeps the fixture unless overridden). */
function perHostNodeInfo(
  overrides: Record<string, { version?: number; seed?: string; fail?: boolean }>,
): Routes {
  const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
  return {
    ...mainnetRoutes(),
    'GET /node/info': (_req: Request, url: URL) => {
      const o = overrides[url.host] ?? {};
      if (o.fail) return jsonResponse({}, 503);
      return jsonResponse({
        ...info,
        version: o.version ?? info.version,
        networkGenerationHashSeed: o.seed ?? info.networkGenerationHashSeed,
      });
    },
  };
}

describe('symbol_version_drift', () => {
  it('reports ok when the node runs the majority version of its peers', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      network: 'mainnet',
      verdict: 'ok',
      node: { version: '1.0.3.9', versionRaw: V_1_0_3_9, restVersion: '2.4.4' },
      sample: { size: 6, source: 'peers', peers: 6, referenceNodes: 0, ignored: 0 },
      distribution: [
        { version: '1.0.3.9', count: 4, share: 0.6667 },
        { version: '1.0.4.0', count: 1, share: 0.1667 },
        { version: '1.0.3.8', count: 1, share: 0.1667 },
      ],
      majorityVersion: '1.0.3.9',
      newerShare: 0.1667,
      farBehindShare: 0.75,
    });
    expect(sc.summary).toMatch(
      /^version drift: ok\. node\.test:3001 runs 1\.0\.3\.9; majority of 6 sampled nodes runs 1\.0\.3\.9; 17% run something newer\.$/,
    );
    expect(JSON.parse(result.text)).toEqual(sc);
    expect(versionDriftTool.outputSchema.safeParse(sc).success).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of ['/node/info', '/node/server', '/node/peers']) expect(paths).toContain(p);
  });

  it('never reports peer hosts, names or public keys', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_version_drift', { format: 'detailed' });
    for (const peer of peers()) {
      expect(result.text).not.toContain(peer.host as string);
      expect(result.text).not.toContain(peer.publicKey as string);
      expect(result.text).not.toContain('peer 01');
    }
    expect(result.structuredContent?.summary).toMatch(/- 1\.0\.3\.9: 4 \(67%\)/);
  });

  it('is behind when older than the majority even though fewer than half are newer', async () => {
    // own 1.0.3.8; sample 1.0.4.0 x3, 1.0.3.8 x2, 1.0.3.7 x2 -> majority 1.0.4.0, newerShare 0.4286
    const versions = [V_1_0_4_0, V_1_0_4_0, V_1_0_4_0, V_1_0_3_8, V_1_0_3_8, V_1_0_3_7, V_1_0_3_7];
    const base = peers();
    const seventh = { ...(base[0] as Peer), publicKey: H('fixture:peer-07') };
    const list = [...base, seventh].map((p, i) => ({ ...p, version: versions[i] }));
    server = await startTestServer({
      routes: {
        ...perHostNodeInfo({ [TEST_NODE_HOST]: { version: V_1_0_3_8 } }),
        'GET /node/peers': list,
      },
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent).toMatchObject({
      verdict: 'behind',
      node: { version: '1.0.3.8' },
      majorityVersion: '1.0.4.0',
      newerShare: 0.4286,
    });
    expect(result.structuredContent?.summary).toMatch(/BEHIND the majority/);
    expect(result.structuredContent?.summary).toMatch(/plan the upgrade/);
  });

  it('is far_behind when at least 75% of the sample is newer', async () => {
    const list = peers().map((p) => ({ ...p, version: V_1_0_4_0 }));
    server = await startTestServer({ routes: routes({ 'GET /node/peers': list }) });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent).toMatchObject({
      verdict: 'far_behind',
      majorityVersion: '1.0.4.0',
      newerShare: 1,
    });
    expect(result.structuredContent?.summary).toMatch(/FAR BEHIND/);
    expect(result.structuredContent?.summary).toMatch(/refusing connections/);
  });

  it('is behind when own version is the mode but newer versions hold half the sample', async () => {
    const versions = [V_1_0_3_9, V_1_0_3_9, V_1_0_4_0, V_1_0_4_0, V_1_0_3_8, V_1_0_3_8];
    const list = peers().map((p, i) => ({ ...p, version: versions[i] }));
    // 1.0.3.9 x2, 1.0.4.0 x2, 1.0.3.8 x2: tie on count, the newer version becomes the majority.
    server = await startTestServer({ routes: routes({ 'GET /node/peers': list }) });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent).toMatchObject({
      verdict: 'behind',
      majorityVersion: '1.0.4.0',
      newerShare: 0.3333,
    });
  });

  it('is unknown without peers and points at the reference-node setting', async () => {
    server = await startTestServer({ routes: routes({ 'GET /node/peers': [] }) });
    let result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      verdict: 'unknown',
      sample: { size: 0, source: 'peers', peers: 0 },
      majorityVersion: null,
      newerShare: null,
      distribution: [],
    });
    expect(result.structuredContent?.summary).toMatch(/SYMBOL_REFERENCE_NODES/);
    expect(result.structuredContent?.summary).toMatch(/symbol_node_health/);
    expect(versionDriftTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    await server.close();

    server = await startTestServer({
      routes: routes({ 'GET /node/peers': () => jsonResponse({}, 503) }),
    });
    result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('unknown');
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/did not answer \/node\/peers/),
    );
  });

  it('adds reachable same-network reference nodes to the sample and only queries /node/info there', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: `${REF_A},${REF_B}` },
      routes: perHostNodeInfo({
        'reference-a.test:3001': { version: V_1_0_4_0 },
        'reference-b.test:3001': { fail: true },
      }),
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      verdict: 'ok',
      sample: { size: 7, source: 'peers+reference', peers: 6, referenceNodes: 1 },
      distribution: [
        { version: '1.0.3.9', count: 4 },
        { version: '1.0.4.0', count: 2 },
        { version: '1.0.3.8', count: 1 },
      ],
    });
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/1 reference node\(s\) could not be reached/),
    );
    expect(new Set(server.requests.map((u) => u.host))).toEqual(
      new Set([TEST_NODE_HOST, 'reference-a.test:3001', 'reference-b.test:3001']),
    );
    const refPaths = new Set(
      server.requests.filter((u) => u.host !== TEST_NODE_HOST).map((u) => u.pathname),
    );
    expect([...refPaths]).toEqual(['/node/info']);
  });

  it('excludes reference nodes on another network', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: REF_A },
      routes: perHostNodeInfo({
        'reference-a.test:3001': { version: V_1_0_4_0, seed: TESTNET_SEED },
      }),
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent).toMatchObject({
      sample: { size: 6, source: 'peers', referenceNodes: 0 },
    });
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/on another network/),
    );
  });

  it('ignores the node itself, peers on another network and malformed entries', async () => {
    const own = fixture<{ publicKey: string }>('mainnet/node-info.json').publicKey;
    const list: Peer[] = [
      ...peers(),
      { ...(peers()[0] as Peer), publicKey: own, version: V_1_0_4_0 },
      {
        ...(peers()[0] as Peer),
        publicKey: H('fixture:peer-testnet'),
        networkGenerationHashSeed: TESTNET_SEED,
        version: V_1_0_4_0,
      },
      { version: 'x', publicKey: 'nope' },
    ];
    server = await startTestServer({ routes: routes({ 'GET /node/peers': list }) });
    const result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      verdict: 'ok',
      sample: { size: 6, peers: 6, ignored: 3 },
    });
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/3 peer entries were ignored/),
    );
  });

  // catapult starts the peers it reads from its peers files at version 0 (0.0.0.0) until it learns
  // the real version: that is "not known", not a release, so it is counted apart.
  it('counts peers that report no version (0.0.0.0) apart from the distribution', async () => {
    const unreported = [1, 2, 3].map((i) => ({
      ...(peers()[0] as Peer),
      publicKey: H(`fixture:peer-unreported-${i}`),
      version: 0,
    }));
    server = await startTestServer({
      routes: routes({ 'GET /node/peers': [...peers(), ...unreported] }),
    });
    const result = await server.callTool('symbol_version_drift', { format: 'detailed' });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      verdict: 'ok',
      sample: { size: 6, peers: 6, referenceNodes: 0, ignored: 0, unknownVersion: 3 },
      distribution: [
        { version: '1.0.3.9', count: 4, share: 0.6667 },
        { version: '1.0.4.0', count: 1, share: 0.1667 },
        { version: '1.0.3.8', count: 1, share: 0.1667 },
      ],
      majorityVersion: '1.0.3.9',
      newerShare: 0.1667,
    });
    const summary = sc.summary as string;
    expect(summary.split('\n')[0]).toBe(
      'version drift: ok. node.test:3001 runs 1.0.3.9; majority of 6 sampled nodes runs 1.0.3.9; 17% run something newer; 3 nodes reported no version (0.0.0.0) and are not counted.',
    );
    expect(summary).not.toMatch(/- 0\.0\.0\.0/);
    expect(sc.notes).toContainEqual(
      expect.stringMatching(
        /^3 nodes reported version 0\.0\.0\.0, which means the version is not known yet/,
      ),
    );
    expect(versionDriftTool.outputSchema.safeParse(sc).success).toBe(true);
  });

  it('does not let unreported versions become the majority', async () => {
    // own 1.0.3.8; peers 1.0.4.0 x2 and 0 x4. Counted as a version, 0.0.0.0 was the majority, the
    // node looked newer than it and the verdict was ok; without them every sampled node is newer.
    const versions = [V_1_0_4_0, V_1_0_4_0, 0, 0, 0, 0];
    const list = peers().map((p, i) => ({ ...p, version: versions[i] }));
    server = await startTestServer({
      routes: {
        ...perHostNodeInfo({ [TEST_NODE_HOST]: { version: V_1_0_3_8 } }),
        'GET /node/peers': list,
      },
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent).toMatchObject({
      verdict: 'far_behind',
      sample: { size: 2, peers: 2, unknownVersion: 4 },
      distribution: [{ version: '1.0.4.0', count: 2, share: 1 }],
      majorityVersion: '1.0.4.0',
      newerShare: 1,
    });
  });

  it('is unknown when no peer has reported its version yet', async () => {
    const list = peers().map((p) => ({ ...p, version: 0 }));
    server = await startTestServer({ routes: routes({ 'GET /node/peers': list }) });
    const result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      verdict: 'unknown',
      sample: { size: 0, peers: 0, unknownVersion: 6 },
      distribution: [],
      majorityVersion: null,
      newerShare: null,
    });
    expect(result.structuredContent?.summary).toBe(
      [
        'version drift: unknown. node.test:3001 runs 1.0.3.9 but the sample is empty (no usable peers; 6 nodes reported no version (0.0.0.0)).',
        '- The peers node.test:3001 knows have not reported their versions yet: check again later, check peer connectivity with symbol_node_health and symbol_node_status, or set SYMBOL_REFERENCE_NODES to compare against known nodes.',
      ].join('\n'),
    );
  });

  it('counts a reference node that reports no version apart', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: REF_A },
      routes: perHostNodeInfo({ 'reference-a.test:3001': { version: 0 } }),
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent).toMatchObject({
      verdict: 'ok',
      sample: { size: 6, source: 'peers', peers: 6, referenceNodes: 0, unknownVersion: 1 },
    });
    expect(result.structuredContent?.summary).toMatch(
      /; 1 node reported no version \(0\.0\.0\.0\) and is not counted\.$/,
    );
  });

  it('tolerates a failing /node/server', async () => {
    server = await startTestServer({
      routes: routes({ 'GET /node/server': () => jsonResponse({}, 503) }),
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.node).toMatchObject({ restVersion: null });
    expect(versionDriftTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });
});
