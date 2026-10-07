import { afterEach, describe, expect, it } from 'vitest';
import { findNetworkByIdentifier } from '../../src/domain/network.js';
import { nodeStatusTool } from '../../src/tools/symbol_node_status.js';
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
type Result = { structuredContent?: Record<string, unknown> | undefined };

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

/** Height of the chain-info fixture, and the path of its latest block. */
const HEIGHT = 5_763_675;
const LATEST_BLOCK = `GET /blocks/${HEIGHT}`;

/** The fixture's latest block with another timestamp. */
function latestBlockWith(timestamp: string) {
  const block = fixture<{ block: Record<string, unknown> }>(`mainnet/block-${HEIGHT}.json`);
  return { ...block, block: { ...block.block, timestamp } };
}

/**
 * The fixture's latest block with its timestamp moved so that it is `ageMs` old at TEST_NOW. The
 * clock is left alone, so clock_skew stays ok and only the age of the chain tip changes.
 */
function latestBlockAged(ageMs: number) {
  const block = fixture<{ block: { timestamp: string } }>(`mainnet/block-${HEIGHT}.json`);
  const shift = TEST_NOW.getTime() - ageMs - FIXTURE_BLOCK_TIME.getTime();
  return latestBlockWith(String(Number(block.block.timestamp) + shift));
}

function chainWith(over: { height?: string; finalized?: string }) {
  const chain = fixture<{ height: string; latestFinalizedBlock: { height: string } }>(
    'mainnet/chain-info.json',
  );
  return {
    ...chain,
    height: over.height ?? chain.height,
    latestFinalizedBlock: {
      ...chain.latestFinalizedBlock,
      height: over.finalized ?? chain.latestFinalizedBlock.height,
    },
  };
}

function checksOf(result: Result): Check[] {
  return result.structuredContent?.checks as Check[];
}

function statusesOf(result: Result): Array<[string, string]> {
  return checksOf(result).map((c) => [c.id, c.status]);
}

/** Every check ok but the ones named. */
function allOkBut(others: Record<string, string>): Array<[string, string]> {
  return CHECK_IDS.map((id) => [id, others[id] ?? 'ok']);
}

function summaryLines(result: Result): string[] {
  return String(result.structuredContent?.summary).split('\n');
}

function notesOf(result: Result): string[] {
  return result.structuredContent?.notes as string[];
}

/** Line 1 for the fixture node: the configured host first, then what the node calls itself. */
function line1(verdictAndSync: string): string {
  return `node.test:3001 (friendlyName "fixture-node", host "mainnet-node.example") on mainnet is ${verdictAndSync}.`;
}

const SYNC_UNKNOWN = '; whether it is synced could not be judged';
const RETRY_HINT = 'Retry later; the other checks do not depend on it.';
/** A timestamp or height beyond the last date and the last safe integer JavaScript knows. */
const OUT_OF_RANGE = '99999999999999999999';
/** Digits too many for a finite number. Any digits pass the uint64 schema of the REST client. */
const TOO_LONG = '9'.repeat(400);

describe('symbol_node_status', () => {
  it('reports a healthy, synced node from the fixtures (block 201 s old, skew -1 s, lag 19 blocks)', async () => {
    server = await startTestServer({ env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' } });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    const now = { utc: '2026-09-10T03:05:00.000Z', local: '2026-09-10T12:05:00+09:00' };
    expect(sc).toEqual({
      summary: [
        line1('healthy and synced'),
        'Symbol 1.0.3.9, roles Peer/API/Voting; height 5,763,675, finalized 5,763,656 (epoch 4004); 6 peers; latest block 201 s old (not synced above 300 s).',
      ].join('\n'),
      verdict: 'healthy',
      sync: {
        synced: true,
        latestBlockTime: { utc: '2026-09-10T03:01:38.808Z', local: '2026-09-10T12:01:38+09:00' },
        ageSeconds: 201,
        thresholdSeconds: 300,
        checkedAt: now,
      },
      // concise: no hints on ok checks
      checks: [
        { id: 'api_node', status: 'ok', detail: 'API node service is up.', hint: null },
        { id: 'db', status: 'ok', detail: 'Database service is up.', hint: null },
        {
          id: 'storage_consistent',
          status: 'ok',
          detail:
            'Database holds 5,763,675 blocks at chain height 5,763,675 (difference 0, tolerance 2).',
          hint: null,
        },
        {
          id: 'clock_skew',
          status: 'ok',
          detail:
            "Node clock is 1,000 ms behind this machine's clock (warn at 15,000 ms, fail at 30,000 ms).",
          hint: null,
        },
        {
          id: 'finalization_lag',
          status: 'ok',
          detail:
            'Finalized height 5,763,656 is 19 blocks (about 9.5 min) behind height 5,763,675 (warn at 720, fail at 1,440 blocks).',
          hint: null,
        },
        { id: 'roles', status: 'ok', detail: 'Roles Peer/API/Voting (a voting node).', hint: null },
        {
          id: 'chain_tip_age',
          status: 'ok',
          // The fixture block is 201.192 s older than TEST_NOW; mainnet's 30 s block time gives
          // 300/900.
          detail:
            'Latest block (height 5,763,675) is 201 s old (about 3.4 min; warn above 300 s, fail above 900 s).',
          hint: null,
        },
      ],
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
      chain: {
        height: 5_763_675,
        finalizedHeight: 5_763_656,
        finalizationEpoch: 4004,
        finalizationPoint: 38,
      },
      storage: { numBlocks: 5_763_675, numTransactions: 24_000_000, numAccounts: 1_100_000 },
      peers: { count: 6 },
      time: {
        nodeTime: { utc: '2026-09-10T03:04:59.000Z', local: '2026-09-10T12:04:59+09:00' },
        localTime: now,
        skewMs: -1000,
      },
      notes: [
        'clock_skew compares the node clock, and chain_tip_age (and with it sync) the time of the latest block, with the clock of the machine running this server (clock_skew including request latency); the local clock may be the one that is off.',
        'storage counts come from the node database as reported by the node and are not backed by chain data.',
        'Thresholds are derived from the network: one minute of blocks for storage, half and one block time for clock skew, half and one epoch (votingSetGrouping blocks) for finalization lag, 10 and 30 block times for the age of the latest block (the node counts as synced up to the first).',
      ],
      invisibleCharactersRemoved: 0,
    });
    expect(Object.keys(sc)).toEqual([
      'summary',
      'verdict',
      'sync',
      'checks',
      'node',
      'network',
      'chain',
      'storage',
      'peers',
      'time',
      'notes',
      'invisibleCharactersRemoved',
    ]);
    expect(JSON.parse(result.text)).toEqual(sc);
    expect(nodeStatusTool.outputSchema.safeParse(sc).success).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of [
      '/node/health',
      '/node/storage',
      '/node/time',
      '/chain/info',
      '/node/info',
      '/node/peers',
      `/blocks/${HEIGHT}`,
    ]) {
      expect(paths).toContain(p);
    }
  });

  it('gives a hint on every check with format detailed, and the same answer otherwise', async () => {
    server = await startTestServer();
    const concise = await server.callTool('symbol_node_status', { format: 'concise' });
    const detailed = await server.callTool('symbol_node_status', { format: 'detailed' });
    expect(checksOf(detailed).map((c) => c.hint)).toEqual([
      'Reported by /node/health status.apiNode.',
      'Reported by /node/health status.db.',
      'Tolerance is about one minute of blocks at the 30-second block time.',
      'Within half a block time; harvesting and transaction deadlines are unaffected.',
      'Less than half an epoch behind is normal finalization progress.',
      'Informational: decoded from the roles bit flags of /node/info.',
      'Thresholds are 10 and 30 times the 30-second target block time; a node that follows the chain has a block at most a few block times old.',
    ]);
    expect({
      ...detailed.structuredContent,
      checks: checksOf(detailed).map((c) => ({ ...c, hint: null })),
    }).toEqual(concise.structuredContent);
  });

  it('grades the age of the latest block against 10 and 30 block times, and is synced up to 10', async () => {
    const cases: Array<[number, string, string, boolean]> = [
      [300_000, 'ok', 'healthy', true],
      [301_000, 'warn', 'degraded', false],
      [900_000, 'warn', 'degraded', false],
      [901_000, 'fail', 'unhealthy', false],
    ];
    for (const [ageMs, status, verdict, synced] of cases) {
      server = await startTestServer({
        routes: routes({ [LATEST_BLOCK]: latestBlockAged(ageMs) }),
      });
      const result = await server.callTool('symbol_node_status');
      expect(result.isError).toBe(false);
      // Only the chain tip moved: the other six checks stay ok.
      expect(statusesOf(result), `${ageMs} ms`).toEqual(allOkBut({ chain_tip_age: status }));
      expect(result.structuredContent?.verdict, `${ageMs} ms`).toBe(verdict);
      expect(result.structuredContent?.sync, `${ageMs} ms`).toMatchObject({
        synced,
        ageSeconds: ageMs / 1000,
        thresholdSeconds: 300,
      });
      expect(summaryLines(result)[0]).toBe(
        line1(`${verdict} and ${synced ? 'synced' : 'NOT synced'}`),
      );
      await server.close();
      server = undefined;
    }
  });

  it('reports a stalled node with the age, the thresholds and a hint', async () => {
    server = await startTestServer({
      routes: routes({ [LATEST_BLOCK]: latestBlockAged(2 * 3_600_000) }),
    });
    const result = await server.callTool('symbol_node_status');
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({ id: 'chain_tip_age', status: 'fail' });
    expect(tip?.detail).toBe(
      'Latest block (height 5,763,675) is 7,200 s old (about 2 h; warn above 300 s, fail above 900 s).',
    );
    expect(tip?.hint).toMatch(/^The node is not adding blocks: it has stalled or fallen behind/);
    expect(summaryLines(result)).toEqual([
      line1('unhealthy and NOT synced'),
      'Symbol 1.0.3.9, roles Peer/API/Voting; height 5,763,675, finalized 5,763,656 (epoch 4004); 6 peers; latest block 7,200 s old (not synced above 300 s).',
      `- chain_tip_age fail: ${tip?.detail}`,
    ]);
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
      const result = await server.callTool('symbol_node_status');
      expect(checksOf(result)[6]?.detail).toBe(`Latest block (height 5,763,675) ${text}`);
      await server.close();
      server = undefined;
    }
  });

  it('derives the chain tip thresholds, and with them the sync threshold, from the block time', async () => {
    const properties = fixture<{ chain: Record<string, unknown> }>(
      'mainnet/network-properties.json',
    );
    server = await startTestServer({
      routes: routes({
        'GET /network/properties': {
          ...properties,
          chain: { ...properties.chain, blockGenerationTargetTime: '15s' },
        },
        // 200 s: synced at a 30 s block time (300 s), not at 15 s (150 s).
        [LATEST_BLOCK]: latestBlockAged(200_000),
      }),
    });
    const result = await server.callTool('symbol_node_status', { format: 'detailed' });
    expect(result.isError).toBe(false);
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({ id: 'chain_tip_age', status: 'warn' });
    expect(tip?.detail).toMatch(
      /is 200 s old \(about 3\.3 min; warn above 150 s, fail above 450 s\)/,
    );
    expect(result.structuredContent?.sync).toMatchObject({
      ageSeconds: 200,
      synced: false,
      thresholdSeconds: 150,
    });
    expect(summaryLines(result)[1]).toMatch(/latest block 200 s old \(not synced above 150 s\)\.$/);
  });

  it('does not count a latest block ahead of the local clock as old', async () => {
    server = await startTestServer({ routes: routes({ [LATEST_BLOCK]: latestBlockAged(-5_000) }) });
    const result = await server.callTool('symbol_node_status', { format: 'detailed' });
    const tip = checksOf(result)[6];
    expect(tip).toMatchObject({ id: 'chain_tip_age', status: 'ok' });
    expect(tip?.detail).toBe(
      "Latest block (height 5,763,675) is timestamped 5 s ahead of this machine's clock, so it is not old (warn above 300 s, fail above 900 s).",
    );
    expect(tip?.hint).toMatch(/^Thresholds are 10 and 30 times the 30-second target block time/);
    expect(result.structuredContent?.sync).toMatchObject({ synced: true, ageSeconds: -5 });
    expect(summaryLines(result)).toEqual([
      line1('healthy and synced'),
      "Symbol 1.0.3.9, roles Peer/API/Voting; height 5,763,675, finalized 5,763,656 (epoch 4004); 6 peers; latest block timestamped 5 s ahead of this machine's clock (not synced above 300 s).",
    ]);
  });

  it('is degraded on storage drift, clock skew and finalization lag warnings', async () => {
    server = await startTestServer({
      now: new Date(TEST_NOW.getTime() + 20_000), // fixture node time is TEST_NOW - 1 s -> skew -21 s
      routes: routes({
        'GET /node/storage': { numBlocks: 5_763_672, numTransactions: 1, numAccounts: 1 },
        'GET /chain/info': chainWith({ finalized: String(5_763_675 - 800) }),
      }),
    });
    const result = await server.callTool('symbol_node_status', { format: 'detailed' });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.verdict).toBe('degraded');
    expect(statusesOf(result)).toEqual(
      allOkBut({ storage_consistent: 'warn', clock_skew: 'warn', finalization_lag: 'warn' }),
    );
    // detailed: hints everywhere
    expect(checksOf(result).every((c) => typeof c.hint === 'string')).toBe(true);
    expect((sc.time as { skewMs: number }).skewMs).toBe(-21_000);
    // A warning on other checks does not make the node "not synced": that is the chain tip alone.
    expect(sc.sync).toMatchObject({ synced: true, ageSeconds: 221 });
    expect(summaryLines(result)).toEqual([
      line1('degraded and synced'),
      'Symbol 1.0.3.9, roles Peer/API/Voting; height 5,763,675, finalized 5,762,875 (epoch 4004); 6 peers; latest block 221 s old (not synced above 300 s).',
      '- storage_consistent warn: Database holds 5,763,672 blocks at chain height 5,763,675 (difference 3, tolerance 2).',
      "- clock_skew warn: Node clock is 21,000 ms behind this machine's clock (warn at 15,000 ms, fail at 30,000 ms).",
      '- finalization_lag warn: Finalized height 5,762,875 is 800 blocks (about 400 min) behind height 5,763,675 (warn at 720, fail at 1,440 blocks).',
    ]);
  });

  it('reads the body of a 503 /node/health answer and reports the down service', async () => {
    server = await startTestServer({
      routes: routes({
        'GET /node/health': () => jsonResponse({ status: { apiNode: 'up', db: 'down' } }, 503),
      }),
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('unhealthy');
    expect(statusesOf(result)).toEqual(allOkBut({ db: 'fail' }));
    const db = checksOf(result)[1];
    expect(db).toMatchObject({ id: 'db', status: 'fail', detail: 'Database service is down.' });
    expect(db?.hint).toMatch(/MongoDB/);
    // A down service is unhealthy; whether the node follows the chain is a separate answer.
    expect(summaryLines(result)[0]).toBe(line1('unhealthy and synced'));
    expect(summaryLines(result)[2]).toBe('- db fail: Database service is down.');
  });

  it('marks api_node and db as failed when /node/health itself cannot be reached', async () => {
    for (const handler of [
      () => {
        throw new TypeError('fetch failed');
      },
      () => jsonResponse({ code: 'Internal', message: 'boom' }, 500),
    ]) {
      server = await startTestServer({ routes: routes({ 'GET /node/health': handler }) });
      const result = await server.callTool('symbol_node_status');
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.verdict).toBe('unhealthy');
      expect(statusesOf(result)).toEqual(allOkBut({ api_node: 'fail', db: 'fail' }));
      expect(checksOf(result)[0]?.detail).toMatch(
        /did not answer \/node\/health \((unreachable|http 500)\)/,
      );
      await server.close();
      server = undefined;
    }
  });

  it('treats a failed or empty /node/time as an unknown clock check (degraded)', async () => {
    server = await startTestServer({
      routes: routes({ 'GET /node/time': () => jsonResponse({}, 503) }),
    });
    let result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    expect(statusesOf(result)).toEqual(allOkBut({ clock_skew: 'unknown' }));
    expect(checksOf(result)[3]?.detail).toMatch(/http 503/);
    expect(result.structuredContent?.time).toEqual({
      nodeTime: null,
      localTime: { utc: TEST_NOW.toISOString() },
      skewMs: null,
    });
    expect(summaryLines(result)[2]).toMatch(/^- clock_skew unknown: /);
    await server.close();

    server = await startTestServer({
      routes: routes({ 'GET /node/time': { communicationTimestamps: {} } }),
    });
    result = await server.callTool('symbol_node_status');
    expect(checksOf(result)[3]).toMatchObject({
      status: 'unknown',
      detail: `${TEST_NODE_HOST} answered /node/time without a timestamp.`,
    });
    expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('treats a node time that is no valid time as an unknown clock check, not an error', async () => {
    for (const timestamp of [OUT_OF_RANGE, TOO_LONG]) {
      server = await startTestServer({
        routes: routes({
          'GET /node/time': {
            communicationTimestamps: { sendTimestamp: timestamp, receiveTimestamp: timestamp },
          },
        }),
      });
      const result = await server.callTool('symbol_node_status');
      expect(result.isError, result.text).toBe(false);
      expect(result.structuredContent?.verdict).toBe('degraded');
      expect(statusesOf(result)).toEqual(allOkBut({ clock_skew: 'unknown' }));
      expect(checksOf(result)[3]).toEqual({
        id: 'clock_skew',
        status: 'unknown',
        detail: `${TEST_NODE_HOST} answered /node/time with a timestamp that is not a valid time.`,
        hint: RETRY_HINT,
      });
      expect(result.structuredContent?.time).toMatchObject({ nodeTime: null, skewMs: null });
      // The latest block is still judged against the local clock.
      expect(result.structuredContent?.sync).toMatchObject({ synced: true, ageSeconds: 201 });
      expect(summaryLines(result)[0]).toBe(line1('degraded and synced'));
      expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
      await server.close();
      server = undefined;
    }
  });

  it('answers with what it has when /node/storage and /chain/info fail', async () => {
    server = await startTestServer({
      routes: routes({
        'GET /node/storage': () => jsonResponse({}, 503),
        'GET /chain/info': () => jsonResponse({}, 503),
      }),
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    expect(statusesOf(result)).toEqual(
      allOkBut({
        storage_consistent: 'unknown',
        finalization_lag: 'unknown',
        chain_tip_age: 'unknown',
      }),
    );
    const chainFailure = `${TEST_NODE_HOST} did not answer /chain/info (http 503).`;
    expect(checksOf(result)[2]?.detail).toBe(
      `${TEST_NODE_HOST} did not answer /node/storage (http 503).`,
    );
    expect(checksOf(result)[4]?.detail).toBe(chainFailure);
    // Without the chain height there is no latest block to ask for.
    expect(checksOf(result)[6]?.detail).toBe(chainFailure);
    expect(server.requests.some((u) => u.pathname.startsWith('/blocks/'))).toBe(false);
    expect(result.structuredContent).toMatchObject({
      storage: null,
      chain: null,
      sync: { synced: null, latestBlockTime: null, ageSeconds: null, thresholdSeconds: 300 },
    });
    expect(summaryLines(result).slice(0, 2)).toEqual([
      line1(`degraded${SYNC_UNKNOWN}`),
      'Symbol 1.0.3.9, roles Peer/API/Voting; height unknown; 6 peers; age of the latest block unknown.',
    ]);
    expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('answers without /node/info: no node, no network, roles unknown, the host still first', async () => {
    // The harness verifies the network at start-up with /node/info, so fail it only afterwards.
    let calls = 0;
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    server = await startTestServer({
      routes: routes({
        'GET /node/info': () => (calls++ === 0 ? jsonResponse(info) : jsonResponse({}, 503)),
      }),
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    expect(statusesOf(result)).toEqual(allOkBut({ roles: 'unknown' }));
    expect(checksOf(result)[5]?.detail).toBe(
      `${TEST_NODE_HOST} did not answer /node/info (http 503).`,
    );
    expect(result.structuredContent).toMatchObject({ node: null, network: null });
    expect(summaryLines(result)).toEqual([
      'node.test:3001 on mainnet is degraded and synced.',
      'Version and roles unknown; height 5,763,675, finalized 5,763,656 (epoch 4004); 6 peers; latest block 201 s old (not synced above 300 s).',
      `- roles unknown: ${TEST_NODE_HOST} did not answer /node/info (http 503).`,
    ]);
    expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('answers without /node/peers: the peer count is unknown and no check changes', async () => {
    server = await startTestServer({
      routes: routes({ 'GET /node/peers': () => jsonResponse({}, 503) }),
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError, result.text).toBe(false);
    const remark = `${TEST_NODE_HOST} did not answer /node/peers (http 503). The peer count is unknown.`;
    expect(result.structuredContent).toMatchObject({ verdict: 'healthy', peers: null });
    expect(statusesOf(result)).toEqual(allOkBut({}));
    expect(notesOf(result).at(-1)).toBe(remark);
    expect(summaryLines(result)).toEqual([
      line1('healthy and synced'),
      'Symbol 1.0.3.9, roles Peer/API/Voting; height 5,763,675, finalized 5,763,656 (epoch 4004); peer count unknown; latest block 201 s old (not synced above 300 s).',
      `- ${remark}`,
    ]);
    expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('counts one peer as 1 peer', async () => {
    server = await startTestServer({ routes: routes({ 'GET /node/peers': [{}] }) });
    const result = await server.callTool('symbol_node_status');
    expect(result.structuredContent?.peers).toEqual({ count: 1 });
    expect(summaryLines(result)[1]).toContain('; 1 peer; ');
  });

  it('fails the clock check at a whole block time of skew', async () => {
    server = await startTestServer({ now: new Date(TEST_NOW.getTime() + 31_000) });
    const result = await server.callTool('symbol_node_status');
    const clock = checksOf(result)[3];
    expect(clock).toMatchObject({ id: 'clock_skew', status: 'fail' });
    expect(clock?.hint).toMatch(/harvested blocks/);
    expect(result.structuredContent?.verdict).toBe('unhealthy');
  });

  it('treats a latest block it cannot fetch as an unknown chain tip (degraded, sync not judged)', async () => {
    server = await startTestServer({
      routes: routes({ [LATEST_BLOCK]: () => jsonResponse({}, 503) }),
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.verdict).toBe('degraded');
    expect(checksOf(result)[6]).toEqual({
      id: 'chain_tip_age',
      status: 'unknown',
      detail: `${TEST_NODE_HOST} did not answer /blocks/${HEIGHT} (http 503).`,
      hint: RETRY_HINT,
    });
    expect(result.structuredContent?.chain).toMatchObject({ height: HEIGHT });
    expect(result.structuredContent?.sync).toMatchObject({
      synced: null,
      latestBlockTime: null,
      ageSeconds: null,
    });
    expect(summaryLines(result)).toEqual([
      line1(`degraded${SYNC_UNKNOWN}`),
      'Symbol 1.0.3.9, roles Peer/API/Voting; height 5,763,675, finalized 5,763,656 (epoch 4004); 6 peers; age of the latest block unknown.',
      `- chain_tip_age unknown: ${TEST_NODE_HOST} did not answer /blocks/${HEIGHT} (http 503).`,
    ]);
  });

  it('treats a block timestamp that is no valid time as an unknown chain tip, not an error', async () => {
    // Beyond the last date JavaScript knows (twice), and too long to be a finite number.
    for (const timestamp of ['9000000000000000', OUT_OF_RANGE, TOO_LONG]) {
      server = await startTestServer({
        routes: routes({ [LATEST_BLOCK]: latestBlockWith(timestamp) }),
      });
      const result = await server.callTool('symbol_node_status');
      expect(result.isError, result.text).toBe(false);
      expect(result.structuredContent?.verdict).toBe('degraded');
      expect(statusesOf(result)).toEqual(allOkBut({ chain_tip_age: 'unknown' }));
      expect(checksOf(result)[6]).toEqual({
        id: 'chain_tip_age',
        status: 'unknown',
        detail: `${TEST_NODE_HOST} answered /blocks/${HEIGHT} with a block timestamp that is not a valid time.`,
        hint: RETRY_HINT,
      });
      // Not judged is null, never false: the node is not known to be behind.
      expect(result.structuredContent?.sync).toEqual({
        synced: null,
        latestBlockTime: null,
        ageSeconds: null,
        thresholdSeconds: 300,
        checkedAt: { utc: TEST_NOW.toISOString() },
      });
      expect(summaryLines(result)[0]).toBe(line1(`degraded${SYNC_UNKNOWN}`));
      expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
      await server.close();
      server = undefined;
    }
  });

  it('treats a chain height that is no valid number as an unknown chain, not an error', async () => {
    for (const over of [{ height: OUT_OF_RANGE }, { finalized: OUT_OF_RANGE }]) {
      server = await startTestServer({ routes: routes({ 'GET /chain/info': chainWith(over) }) });
      const result = await server.callTool('symbol_node_status');
      expect(result.isError, result.text).toBe(false);
      expect(result.structuredContent?.verdict).toBe('degraded');
      expect(statusesOf(result)).toEqual(
        allOkBut({
          storage_consistent: 'unknown',
          finalization_lag: 'unknown',
          chain_tip_age: 'unknown',
        }),
      );
      const detail = `${TEST_NODE_HOST} answered /chain/info with a height that is not a valid number.`;
      for (const index of [2, 4, 6]) {
        expect(checksOf(result)[index]).toMatchObject({ detail, hint: RETRY_HINT });
      }
      expect(result.structuredContent).toMatchObject({
        chain: null,
        sync: { synced: null, latestBlockTime: null, ageSeconds: null },
      });
      // No block is asked for at a height that cannot be used.
      expect(server.requests.some((u) => u.pathname.startsWith('/blocks/'))).toBe(false);
      expect(summaryLines(result).slice(0, 2)).toEqual([
        line1(`degraded${SYNC_UNKNOWN}`),
        'Symbol 1.0.3.9, roles Peer/API/Voting; height unknown; 6 peers; age of the latest block unknown.',
      ]);
      expect(nodeStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
      await server.close();
      server = undefined;
    }
  });

  it('cleans the friendly name and counts what it removed', async () => {
    const info = {
      ...fixture<Record<string, unknown>>('mainnet/node-info.json'),
      // NUL and RIGHT-TO-LEFT OVERRIDE, built from code points so this file holds neither.
      friendlyName: `fix${String.fromCodePoint(0)}ture-node${String.fromCodePoint(0x202e)}`,
    };
    server = await startTestServer({ routes: routes({ 'GET /node/info': info }) });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.node).toMatchObject({ friendlyName: 'fixture-node' });
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(2);
    expect(summaryLines(result)[0]).toBe(line1('healthy and synced'));
  });

  it('says so when the node reports another network than at start-up', async () => {
    const testnet = findNetworkByIdentifier(152);
    if (!testnet) throw new Error('testnet is a known network');
    // The harness verifies the network at start-up with /node/info, so change it only afterwards.
    let calls = 0;
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    const moved = {
      ...info,
      networkGenerationHashSeed: testnet.generationHashSeed,
      networkIdentifier: testnet.identifier,
    };
    server = await startTestServer({
      routes: routes({ 'GET /node/info': () => jsonResponse(calls++ === 0 ? info : moved) }),
    });
    const result = await server.callTool('symbol_node_status');
    expect(result.isError).toBe(false);
    const remark =
      'The node now reports a different network (testnet) than at start-up (mainnet). Check SYMBOL_NODE_URL and restart this server: its network properties were read at start-up.';
    expect(result.structuredContent?.network).toEqual({
      name: 'testnet',
      identifier: 152,
      matchesConfiguredNetwork: false,
    });
    expect(notesOf(result).at(-1)).toBe(remark);
    expect(summaryLines(result).at(-1)).toBe(`- ${remark}`);
    // No check covers it, so the verdict does not change.
    expect(result.structuredContent?.verdict).toBe('healthy');
  });

  it('never contacts the reference nodes', async () => {
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: 'https://reference-a.test:3001' },
    });
    await server.callTool('symbol_node_status');
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });
});
