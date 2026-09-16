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
import { harvesterWatchTool } from '../../src/tools/symbol_harvester_watch.js';
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

let server: TestServer | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symbol-mcp-watch-'));
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

function snapshot(daysAgo: number, keys: string[], height = 5_763_000) {
  return { takenAt: new Date(TEST_NOW.getTime() - daysAgo * DAY).toISOString(), height, keys };
}

function writeState(state: HarvesterState, at = join(dir, FILE_NAME)): void {
  writeFileSync(at, JSON.stringify(state));
}

function readState(at = join(dir, FILE_NAME)): HarvesterState {
  return HarvesterStateSchema.parse(JSON.parse(readFileSync(at, 'utf8')));
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

describe('symbol_harvester_watch', () => {
  it('reports the current list only when SYMBOL_STATE_DIR is unset, writing nothing', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvester_watch');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      mode: 'compare_and_save',
      node: { host: TEST_NODE_HOST, publicKey: NODE_KEY },
      current: {
        count: 15,
        height: 5_763_675,
        takenAt: { utc: TEST_NOW.toISOString() },
        keys: null,
      },
      comparison: null,
      history: null,
      saved: false,
      stateFile: null,
    });
    expect(result.structuredContent?.summary).toBe(
      `15 unlocked harvesters on ${TEST_NODE_HOST}. SYMBOL_STATE_DIR is not set, so no comparison.`,
    );
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/SYMBOL_STATE_DIR is not set/),
    );
    expect(readdirSync(dir)).toEqual([]);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of ['/node/info', '/node/unlockedaccount', '/chain/info'])
      expect(paths).toContain(p);
    expect(JSON.parse(result.text)).toEqual(result.structuredContent);
    expect(harvesterWatchTool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('saves a baseline on the first call and diffs against it on the second', async () => {
    server = await startTestServer({
      env: { SYMBOL_STATE_DIR: dir, SYMBOL_TIMEZONE: 'Asia/Tokyo' },
      now: new Date(TEST_NOW.getTime() - DAY),
    });
    const first = await server.callTool('symbol_harvester_watch');
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({
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
    const second = await server.callTool('symbol_harvester_watch', { format: 'detailed' });
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
    expect(second.structuredContent?.summary).toMatch(
      /^16 unlocked harvesters on node\.test:3001 \(was 15 on 2026-09-09T12:05:00\+09:00 \(2026-09-09T03:05:00\.000Z\)\): \+2 -1\. Snapshot saved \(2 stored\)\.$/,
    );
    expect(readState().snapshots.map((s) => s.keys.length)).toEqual([16, 15]);
    expect(harvesterWatchTool.outputSchema.safeParse(second.structuredContent).success).toBe(true);
  });

  it('save_only appends without comparing; compare reads without growing the file', async () => {
    writeState({
      version: 1,
      nodePublicKey: NODE_KEY,
      snapshots: [snapshot(1, FIXTURE_KEYS), snapshot(2, FIXTURE_KEYS.slice(0, 10))],
    });
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
    const saved = await server.callTool('symbol_harvester_watch', { mode: 'save_only' });
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
      const result = await server.callTool('symbol_harvester_watch', { mode: 'compare' });
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
    const result = await server.callTool('symbol_harvester_watch', { mode: 'compare' });
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
    let result = await server.callTool('symbol_harvester_watch', { mode: 'compare' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: false });
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/Could not read .* \(invalid JSON\).*Nothing was written/),
    );
    expect(readFileSync(join(dir, FILE_NAME), 'utf8')).toBe('{not json');

    result = await server.callTool('symbol_harvester_watch');
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: true });
    expect(result.structuredContent?.summary).toMatch(
      /Previous snapshot unusable; baseline saved \(1 stored\)\./,
    );
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/The file was overwritten/),
    );
    expect(readState().snapshots).toHaveLength(1);

    writeState({ version: 1, nodePublicKey: 'A'.repeat(64), snapshots: [snapshot(1, [])] });
    result = await server.callTool('symbol_harvester_watch');
    expect(result.structuredContent).toMatchObject({ comparison: null, saved: true });
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/another node key/),
    );
    expect(readState().nodePublicKey).toBe(NODE_KEY);
  });

  it('keeps the newest 60 snapshots and windows the history to 30 days', async () => {
    const old = Array.from({ length: MAX_SNAPSHOTS }, (_, i) =>
      snapshot(i + 1, FIXTURE_KEYS.slice(0, 5), i === MAX_SNAPSHOTS - 1 ? 1 : 5_000_000 + i),
    );
    writeState({ version: 1, nodePublicKey: NODE_KEY, snapshots: old });
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: dir } });
    const result = await server.callTool('symbol_harvester_watch', { format: 'detailed' });
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
    expect(result.structuredContent?.notes).toContainEqual(
      expect.stringMatching(/newest 60 snapshots/),
    );
  });

  it('writes only inside the resolved SYMBOL_STATE_DIR', async () => {
    mkdirSync(join(dir, 'a'));
    server = await startTestServer({ env: { SYMBOL_STATE_DIR: join(dir, 'a', '..', 'b') } });
    const result = await server.callTool('symbol_harvester_watch');
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.stateFile).toBe(join(dir, 'b', FILE_NAME));
    expect(readdirSync(join(dir, 'b'))).toEqual([FILE_NAME]);
    expect(readdirSync(join(dir, 'a'))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['a', 'b']);
  });

  it('refuses to run, and writes nothing, when the node reports no or an unusable nodePublicKey', async () => {
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    for (const bad of [undefined, '../../x', `${'A'.repeat(64)}/`]) {
      const variant = { ...info };
      if (bad === undefined) delete variant.nodePublicKey;
      else variant.nodePublicKey = bad;
      let calls = 0;
      server = await startTestServer({
        env: { SYMBOL_STATE_DIR: dir },
        // The harness verifies the network with the first /node/info; serve the variant afterwards.
        routes: routes({
          'GET /node/info': () => jsonResponse(calls++ === 0 ? info : variant),
        }),
      });
      const result = await server.callTool('symbol_harvester_watch');
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(
        bad === undefined ? /nodePublicKey/ : /unexpected response shape/,
      );
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
      const soft = await server.callTool('symbol_harvester_watch');
      expect(soft.isError).toBe(false);
      expect(soft.structuredContent).toMatchObject({ saved: false, comparison: null });
      expect(soft.structuredContent?.summary).toMatch(/baseline NOT saved \(EACCES\)/);
      expect(soft.structuredContent?.notes).toContainEqual(
        expect.stringMatching(/Snapshot not saved/),
      );
      const hard = await server.callTool('symbol_harvester_watch', { mode: 'save_only' });
      expect(hard.isError).toBe(true);
      expect(hard.text).toMatch(/SYMBOL_STATE_DIR/);
      expect(hard.text).not.toMatch(/at .*\.ts/);
    },
  );

  it('rejects an unknown mode', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvester_watch', { mode: 'wipe' });
    expect(result.isError).toBe(true);
  });
});
