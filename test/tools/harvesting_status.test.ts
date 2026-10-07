import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HarvesterState,
  HarvesterStateSchema,
  MAX_SNAPSHOTS,
} from '../../src/domain/harvesterwatch.js';
import { harvestingStatusTool } from '../../src/tools/symbol_harvesting_status.js';
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

const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();
const NODE_KEY = fixture<{ nodePublicKey: string }>('mainnet/node-info.json').nodePublicKey;
const FILE_NAME = `harvesters-${NODE_KEY.slice(0, 16)}.json`;
const FIXTURE_KEYS = [
  ...fixture<{ unlockedAccount: string[] }>('mainnet/unlockedaccount.json').unlockedAccount,
].sort();
const NEW_A = H('fixture:harvester-new-a');
const NEW_B = H('fixture:harvester-new-b');
const DAY = 86_400_000;
const posix = process.platform !== 'win32';
const notRoot = process.getuid?.() !== 0;

/** The harvesting limits of the fixture network, the same in every mode. */
const LIMITS = {
  minHarvesterBalance: '10000.000000',
  rawMinHarvesterBalance: '10000000000',
  maxHarvesterBalance: '50000000.000000',
  rawMaxHarvesterBalance: '50000000000000',
  harvestBeneficiaryPercentage: 25,
  harvestingMosaic: { id: '6BED913FA20223F8', alias: 'symbol.xym', divisibility: 6 },
};
const SAVING_MODES = ['compare', 'compare_and_save', 'save_only'] as const;

let server: TestServer | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symbol-mcp-harvesting-'));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
  rmSync(dir, { recursive: true, force: true });
});

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

/** /node/info without a nodePublicKey, served after the first call (the start-up check). */
function infoWithoutNodeKey(): Routes {
  const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
  const { nodePublicKey: _key, ...without } = info;
  let calls = 0;
  return { 'GET /node/info': () => jsonResponse(calls++ === 0 ? info : without) };
}

function snapshot(daysAgo: number, keys: string[], height = 5_763_000) {
  return { takenAt: new Date(TEST_NOW.getTime() - daysAgo * DAY).toISOString(), height, keys };
}

function writeState(state: HarvesterState, at = join(dir, FILE_NAME)): void {
  writeFileSync(at, JSON.stringify(state));
}

function readState(at = join(dir, FILE_NAME)): HarvesterState {
  return HarvesterStateSchema.parse(JSON.parse(readFileSync(at, 'utf8')));
}

function notesOf(result: { structuredContent?: Record<string, unknown> | undefined }): string[] {
  return result.structuredContent?.notes as string[];
}

type Comparison = {
  previousTakenAt: { utc: string };
  previousHeight: number;
  previousCount: number;
  added: string[];
  removed: string[];
  unchangedCount: number;
  deltaCount: number;
};

describe('symbol_harvesting_status, mode current (the default)', () => {
  it('reports the count and the limits from the node alone', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvesting_status');
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toEqual({
      summary: [
        `15 unlocked harvesters on ${TEST_NODE_HOST}.`,
        'Harvesting requires a balance from 10000.000000 to 50000000.000000 symbol.xym (both inclusive) and non-zero importance; the node keeps 25% of block rewards.',
      ].join('\n'),
      network: 'mainnet',
      mode: 'current',
      node: { host: TEST_NODE_HOST, nodePublicKey: NODE_KEY },
      // concise: the count, not the keys
      current: {
        count: 15,
        takenAt: { utc: TEST_NOW.toISOString() },
        height: 5_763_675,
        keys: null,
      },
      limits: LIMITS,
      comparison: null,
      history: null,
      saved: false,
      stateFile: null,
      notes: [
        "The unlocked list (/node/unlockedaccount) is the node's own report and is not backed by chain data.",
        'Keys are remote (linked) harvesting keys; the delegators’ main accounts cannot be identified from them.',
        'Right after a node restart the unlocked count can be 0 or low for a while, until delegations are re-activated.',
        'Mode current compares nothing. Call again with mode "compare" to see how the list changed since the last stored snapshot, or "compare_and_save" to store the current list as well; both need SYMBOL_STATE_DIR.',
      ],
      invisibleCharactersRemoved: 0,
    });
    expect(Object.keys(sc)).toEqual([
      'summary',
      'network',
      'mode',
      'node',
      'current',
      'limits',
      'comparison',
      'history',
      'saved',
      'stateFile',
      'notes',
      'invisibleCharactersRemoved',
    ]);
    expect(JSON.parse(result.text)).toEqual(sc);
    expect(harvestingStatusTool.outputSchema.safeParse(sc).success).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of ['/node/info', '/node/unlockedaccount', '/chain/info'])
      expect(paths).toContain(p);
    // The same answer when the mode is named.
    const named = await server.callTool('symbol_harvesting_status', { mode: 'current' });
    expect(named.structuredContent).toEqual(sc);
  });

  it('lists the keys only with format detailed: upper case, one each, ascending', async () => {
    const [first] = FIXTURE_KEYS;
    if (!first) throw new Error('the fixture has unlocked keys');
    const list = [...FIXTURE_KEYS].reverse().concat(first.toLowerCase());
    server = await startTestServer({
      routes: routes({ 'GET /node/unlockedaccount': { unlockedAccount: list } }),
    });
    const detailed = await server.callTool('symbol_harvesting_status', { format: 'detailed' });
    expect(detailed.structuredContent?.current).toMatchObject({ count: 15, keys: FIXTURE_KEYS });
    const concise = await server.callTool('symbol_harvesting_status', { format: 'concise' });
    expect(concise.structuredContent?.current).toMatchObject({ count: 15, keys: null });
    // Nothing else depends on the format in this mode.
    expect({
      ...detailed.structuredContent,
      current: concise.structuredContent?.current,
    }).toEqual(concise.structuredContent);
  });

  it('never looks at the snapshot file: no read, no write, no directory', async () => {
    // A file that any reading mode would report as unusable.
    writeFileSync(join(dir, FILE_NAME), '{not json');
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
    const result = await server.callTool('symbol_harvesting_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      mode: 'current',
      comparison: null,
      history: null,
      saved: false,
      stateFile: null,
    });
    expect(
      notesOf(result).filter((n) => /Could not read|baseline|another node key/.test(n)),
    ).toEqual([]);
    expect(notesOf(result)).not.toContainEqual(
      expect.stringMatching(/SYMBOL_STATE_DIR is not set/),
    );
    expect(readFileSync(join(dir, FILE_NAME), 'utf8')).toBe('{not json');
    expect(readdirSync(dir)).toEqual([FILE_NAME]);
    await server.close();

    const never = join(dir, 'never');
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: never } });
    const again = await server.callTool('symbol_harvesting_status');
    expect(again.isError).toBe(false);
    expect(existsSync(never)).toBe(false);
  });

  it('answers a node that reports no nodePublicKey, which the other modes cannot', async () => {
    server = await startTestServer({
      env: { SYMBOL_STATE_DIR: dir },
      routes: routes(infoWithoutNodeKey()),
    });
    const result = await server.callTool('symbol_harvesting_status');
    expect(result.isError, result.text).toBe(false);
    expect(result.structuredContent).toMatchObject({
      node: { host: TEST_NODE_HOST, nodePublicKey: null },
      current: { count: 15 },
      limits: LIMITS,
    });
    expect(harvestingStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(
      true,
    );
    for (const mode of SAVING_MODES) {
      const refused = await server.callTool('symbol_harvesting_status', { mode });
      expect(refused.isError, mode).toBe(true);
      expect(refused.text).toMatch(/does not report a nodePublicKey in \/node\/info/);
      // The way out is named: the default mode needs no snapshot file.
      expect(refused.text).toMatch(/with mode "current" \(the default\)/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('symbol_harvesting_status, the modes that compare and save', () => {
  it('reports the current list only when SYMBOL_STATE_DIR is unset, writing nothing', async () => {
    server = await startTestServer();
    for (const mode of SAVING_MODES) {
      const result = await server.callTool('symbol_harvesting_status', { mode });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        network: 'mainnet',
        mode,
        node: { host: TEST_NODE_HOST, nodePublicKey: NODE_KEY },
        current: {
          count: 15,
          height: 5_763_675,
          takenAt: { utc: TEST_NOW.toISOString() },
          keys: null,
        },
        limits: LIMITS,
        comparison: null,
        history: null,
        saved: false,
        stateFile: null,
      });
      // One line, as the check command prints it.
      expect(result.structuredContent?.summary).toBe(
        `15 unlocked harvesters on ${TEST_NODE_HOST}. SYMBOL_STATE_DIR is not set, so no comparison.`,
      );
      expect(notesOf(result)).toContainEqual(expect.stringMatching(/SYMBOL_STATE_DIR is not set/));
      expect(JSON.parse(result.text)).toEqual(result.structuredContent);
      expect(harvestingStatusTool.outputSchema.safeParse(result.structuredContent).success).toBe(
        true,
      );
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('saves a baseline on the first call and diffs against it on the second', async () => {
    server = await startTestServer({
      env: { SYMBOL_STATE_DIR: dir, SYMBOL_TIMEZONE: 'Asia/Tokyo' },
      now: new Date(TEST_NOW.getTime() - DAY),
    });
    const first = await server.callTool('symbol_harvesting_status', { mode: 'compare_and_save' });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({
      mode: 'compare_and_save',
      comparison: null,
      history: null,
      saved: true,
      stateFile: join(dir, FILE_NAME),
    });
    expect(first.structuredContent?.summary).toBe(
      `15 unlocked harvesters on ${TEST_NODE_HOST}. No previous snapshot; baseline saved (1 stored).`,
    );
    const stored = readState();
    expect(stored).toEqual({
      version: 1,
      nodePublicKey: NODE_KEY,
      snapshots: [
        {
          takenAt: new Date(TEST_NOW.getTime() - DAY).toISOString(),
          height: 5_763_675,
          keys: FIXTURE_KEYS,
        },
      ],
    });
    await server.close();

    const removed = FIXTURE_KEYS[0] as string;
    const list = [...FIXTURE_KEYS.slice(1), NEW_B.toLowerCase(), NEW_A];
    server = await startTestServer({
      env: { SYMBOL_STATE_DIR: dir, SYMBOL_TIMEZONE: 'Asia/Tokyo' },
      routes: routes({ 'GET /node/unlockedaccount': { unlockedAccount: list } }),
    });
    const second = await server.callTool('symbol_harvesting_status', {
      mode: 'compare_and_save',
      format: 'detailed',
    });
    expect(second.isError).toBe(false);
    const comparison = second.structuredContent?.comparison as Comparison;
    expect(comparison).toMatchObject({
      previousTakenAt: { utc: new Date(TEST_NOW.getTime() - DAY).toISOString() },
      previousHeight: 5_763_675,
      previousCount: 15,
      added: [NEW_A, NEW_B].sort(),
      removed: [removed],
      unchangedCount: 14,
      deltaCount: 1,
    });
    expect(second.structuredContent?.current).toMatchObject({
      count: 16,
      keys: [...FIXTURE_KEYS.slice(1), NEW_A, NEW_B].sort(),
    });
    expect(second.structuredContent?.history).toMatchObject({
      snapshots: 1,
      min: 15,
      max: 15,
      average: 15,
      entries: [{ height: 5_763_675, count: 15 }],
    });
    // The limits come with every mode; the summary stays the one line about the list.
    expect(second.structuredContent?.limits).toEqual(LIMITS);
    expect(second.structuredContent?.summary).toMatch(
      /^16 unlocked harvesters on node\.test:3001 \(was 15 on 2026-09-09T12:05:00\+09:00 \(2026-09-09T03:05:00\.000Z\)\): \+2 -1\. Snapshot saved \(2 stored\)\.$/,
    );
    expect(readState().snapshots.map((s) => s.keys.length)).toEqual([16, 15]);
    expect(harvestingStatusTool.outputSchema.safeParse(second.structuredContent).success).toBe(
      true,
    );
  });

  it('reads a snapshot file written before the merge and keeps its name and shape', async () => {
    const [keyA, keyB] = FIXTURE_KEYS;
    // The file as symbol_harvester_watch 0.9.3 wrote it: this name, this layout, a final newline.
    const legacyName = 'harvesters-CEF91B106670BC3F.json';
    const legacyFile = `{
  "version": 1,
  "nodePublicKey": "CEF91B106670BC3FDD3614D8B9E816DAA3286817F79A99F902BDC9CD73EF3568",
  "snapshots": [
    {
      "takenAt": "2026-09-01T07:00:02.000Z",
      "height": 5737000,
      "keys": [
        "${keyA}",
        "${keyB}"
      ]
    }
  ]
}
`;
    writeFileSync(join(dir, legacyName), legacyFile);
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });

    const compared = await server.callTool('symbol_harvesting_status', { mode: 'compare' });
    expect(compared.isError, compared.text).toBe(false);
    expect(compared.structuredContent).toMatchObject({
      comparison: {
        previousTakenAt: { utc: '2026-09-01T07:00:02.000Z' },
        previousHeight: 5_737_000,
        previousCount: 2,
        added: FIXTURE_KEYS.slice(2),
        removed: [],
        unchangedCount: 2,
        deltaCount: 13,
      },
      history: { snapshots: 1, min: 2, max: 2, average: 2 },
      saved: false,
      stateFile: join(dir, legacyName),
    });
    expect(notesOf(compared).filter((n) => /Could not read|baseline/.test(n))).toEqual([]);
    expect(readFileSync(join(dir, legacyName), 'utf8')).toBe(legacyFile);

    const saved = await server.callTool('symbol_harvesting_status', { mode: 'compare_and_save' });
    expect(saved.structuredContent).toMatchObject({ saved: true, comparison: { deltaCount: 13 } });
    // Still one file with that name, the old snapshot kept as it was behind the new one.
    expect(readdirSync(dir)).toEqual([legacyName]);
    const text = readFileSync(join(dir, legacyName), 'utf8');
    expect(text.startsWith('{\n  "version": 1,\n  "nodePublicKey": "CEF91B10')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    const state = HarvesterStateSchema.parse(JSON.parse(text));
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'nodePublicKey', 'snapshots']);
    expect(state.snapshots).toHaveLength(2);
    expect(state.snapshots[0]).toEqual({
      takenAt: TEST_NOW.toISOString(),
      height: 5_763_675,
      keys: FIXTURE_KEYS,
    });
    expect(state.snapshots[1]).toEqual({
      takenAt: '2026-09-01T07:00:02.000Z',
      height: 5_737_000,
      keys: [keyA, keyB],
    });
  });

  it('save_only appends without comparing; compare reads without growing the file', async () => {
    writeState({
      version: 1,
      nodePublicKey: NODE_KEY,
      snapshots: [snapshot(1, FIXTURE_KEYS), snapshot(2, FIXTURE_KEYS.slice(0, 10))],
    });
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
    const saved = await server.callTool('symbol_harvesting_status', { mode: 'save_only' });
    expect(saved.structuredContent).toMatchObject({
      mode: 'save_only',
      comparison: null,
      history: null,
      saved: true,
    });
    expect(saved.structuredContent?.summary).toBe(
      `15 unlocked harvesters on ${TEST_NODE_HOST}. Snapshot saved (3 stored).`,
    );
    expect(readState().snapshots).toHaveLength(3);

    const before = readFileSync(join(dir, FILE_NAME), 'utf8');
    for (let i = 0; i < 2; i++) {
      const result = await server.callTool('symbol_harvesting_status', { mode: 'compare' });
      expect(result.structuredContent).toMatchObject({
        mode: 'compare',
        saved: false,
        comparison: {
          previousCount: 15,
          added: [],
          removed: [],
          unchangedCount: 15,
          deltaCount: 0,
        },
        history: { snapshots: 3, min: 10, max: 15, average: 13.3 },
      });
      expect(result.structuredContent?.summary).toMatch(
        /^15 unlocked harvesters on node\.test:3001, unchanged since /,
      );
    }
    expect(readFileSync(join(dir, FILE_NAME), 'utf8')).toBe(before);
  });

  it('compare never creates the directory', async () => {
    const never = join(dir, 'never');
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: never } });
    const result = await server.callTool('symbol_harvesting_status', { mode: 'compare' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: false });
    expect(result.structuredContent?.summary).toMatch(
      /No previous snapshot; nothing saved in mode compare\./,
    );
    expect(existsSync(never)).toBe(false);
  });

  it('treats a corrupt file or another node’s file as a baseline', async () => {
    writeFileSync(join(dir, FILE_NAME), '{not json');
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
    let result = await server.callTool('symbol_harvesting_status', { mode: 'compare' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: false });
    expect(notesOf(result)).toContainEqual(
      expect.stringMatching(/Could not read .* \(invalid JSON\).*Nothing was written/),
    );
    expect(readFileSync(join(dir, FILE_NAME), 'utf8')).toBe('{not json');

    result = await server.callTool('symbol_harvesting_status', { mode: 'compare_and_save' });
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: true });
    expect(result.structuredContent?.summary).toMatch(
      /Previous snapshot unusable; baseline saved \(1 stored\)\./,
    );
    expect(notesOf(result)).toContainEqual(expect.stringMatching(/The file was overwritten/));
    expect(readState().snapshots).toHaveLength(1);

    writeState({ version: 1, nodePublicKey: 'A'.repeat(64), snapshots: [snapshot(1, [])] });
    result = await server.callTool('symbol_harvesting_status', { mode: 'compare_and_save' });
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: true });
    expect(notesOf(result)).toContainEqual(expect.stringMatching(/another node key/));
    expect(readState().nodePublicKey).toBe(NODE_KEY);
  });

  it('keeps the newest 60 snapshots and windows the history to 30 days', async () => {
    const old = Array.from({ length: MAX_SNAPSHOTS }, (_, i) =>
      snapshot(i + 1, FIXTURE_KEYS.slice(0, 5), i === MAX_SNAPSHOTS - 1 ? 1 : 5_000_000 + i),
    );
    writeState({ version: 1, nodePublicKey: NODE_KEY, snapshots: old });
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
    const result = await server.callTool('symbol_harvesting_status', {
      mode: 'compare_and_save',
      format: 'detailed',
    });
    expect(result.isError).toBe(false);
    const state = readState();
    expect(state.snapshots).toHaveLength(MAX_SNAPSHOTS);
    expect(state.snapshots[0]?.height).toBe(5_763_675);
    expect(state.snapshots.some((s) => s.height === 1)).toBe(false);
    // entries 1..30 days old are in the window (31..60 are not)
    expect(result.structuredContent?.history).toMatchObject({
      snapshots: 30,
      min: 5,
      max: 5,
      average: 5,
    });
    const history = result.structuredContent?.history as { entries: unknown[] };
    expect(history.entries).toHaveLength(30);
    expect(notesOf(result)).toContainEqual(expect.stringMatching(/newest 60 snapshots/));
  });

  it('writes only inside the resolved SYMBOL_STATE_DIR', async () => {
    mkdirSync(join(dir, 'a'));
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: join(dir, 'a', '..', 'b') } });
    const result = await server.callTool('symbol_harvesting_status', { mode: 'compare_and_save' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.stateFile).toBe(join(dir, 'b', FILE_NAME));
    expect(readdirSync(join(dir, 'b'))).toEqual([FILE_NAME]);
    expect(readdirSync(join(dir, 'a'))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['a', 'b']);
  });

  it('refuses to run, and writes nothing, when the node reports an unusable nodePublicKey', async () => {
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    for (const bad of ['../../x', `${'A'.repeat(64)}/`]) {
      let calls = 0;
      server = await startTestServer({
        env: { SYMBOL_STATE_DIR: dir },
        // The harness verifies the network with the first /node/info; serve the variant afterwards.
        routes: routes({
          'GET /node/info': () =>
            jsonResponse(calls++ === 0 ? info : { ...info, nodePublicKey: bad }),
        }),
      });
      const result = await server.callTool('symbol_harvesting_status', {
        mode: 'compare_and_save',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/unexpected response shape/);
      expect(readdirSync(dir)).toEqual([]);
      await server.close();
      server = undefined;
    }
  });

  it.skipIf(!posix || !notRoot)(
    'reports a write failure as a note in compare_and_save and as an error in save_only',
    async () => {
      chmodSync(dir, 0o500);
      server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
      const soft = await server.callTool('symbol_harvesting_status', { mode: 'compare_and_save' });
      expect(soft.isError).toBe(false);
      expect(soft.structuredContent).toMatchObject({ saved: false, comparison: null });
      expect(soft.structuredContent?.summary).toMatch(/baseline NOT saved \(EACCES\)/);
      expect(notesOf(soft)).toContainEqual(expect.stringMatching(/Snapshot not saved/));
      const hard = await server.callTool('symbol_harvesting_status', { mode: 'save_only' });
      expect(hard.isError).toBe(true);
      expect(hard.text).toMatch(/SYMBOL_STATE_DIR/);
      expect(hard.text).not.toMatch(/at .*\.ts/);
    },
  );

  it('rejects an unknown mode', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvesting_status', { mode: 'wipe' });
    expect(result.isError).toBe(true);
  });
});
