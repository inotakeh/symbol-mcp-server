/**
 * `symbol-mcp-server check` against the fixture node: runCheck calls the tools' run functions
 * directly (no MCP client or transport here) with the node-side fetch stubbed by the harness.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IDS, type CheckReport, CheckReportSchema, runCheck } from '../../src/cli/check.js';
import { formatCheckJson, formatCheckText } from '../../src/cli/format.js';
import { UNAVAILABLE_NOTE } from '../../src/tools/symbol_finality_participation.js';
import {
  NOT_SAVED_NOTE_PREFIX,
  RESTART_NOTE,
  UNSET_NOTE,
} from '../../src/tools/symbol_harvester_watch.js';
import {
  ALIAS_NAMESPACE_NAME,
  createFakeFetch,
  createTestContext,
  fixture,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  TEST_NODE_HOST,
  TEST_NOW,
} from './harness.js';

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
/** Latest finalized epoch of the chain-info fixture; the captured proof is for epoch 4010. */
const LATEST_EPOCH = 4004;
const posix = process.platform !== 'win32';
const notRoot = process.getuid?.() !== 0;

/** The epoch 4010 proof re-labelled as the latest finalized epoch, so the account participated. */
function proofAtLatestEpoch(): Routes {
  const proof = fixture<Record<string, unknown>>('mainnet/finalization-proof-epoch.json');
  return {
    [`GET /finalization/proof/epoch/${LATEST_EPOCH}`]: {
      ...proof,
      finalizationEpoch: LATEST_EPOCH,
    },
  };
}

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...proofAtLatestEpoch(), ...extra };
}

function statuses(report: CheckReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
}

function item(report: CheckReport, id: (typeof CHECK_IDS)[number]) {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} in the report`);
  return found;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symbol-mcp-check-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('runCheck against the fixture node', () => {
  it('is OK with exit code 0 when every item is ok', async () => {
    const { ctx, requests } = await createTestContext({
      routes: routes(),
      env: { SYMBOL_STATE_DIR: dir, SYMBOL_TIMEZONE: 'Asia/Tokyo' },
    });
    const report = await runCheck(ctx, { account: ADDRESS, warnDays: 14 });

    expect(report.verdict).toBe('ok');
    expect(report.exitCode).toBe(0);
    expect(report.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(report.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(item(report, 'node_health').detail).toBe('healthy (finalization lag 19 blocks)');
    expect(item(report, 'harvester_watch').detail).toContain('baseline saved');
    expect(item(report, 'voting_key_status').detail).toMatch(
      /^active key 534A99C9… expires in about 27\.\d days \(epoch 4059, estimated /,
    );
    expect(item(report, 'finality_participation').detail).toBe(
      `epoch ${LATEST_EPOCH}: participated`,
    );
    expect(report.account).toBe(ADDRESS);
    expect(report.warnDays).toBe(14);
    expect(report.node).toEqual({ host: TEST_NODE_HOST, network: 'mainnet' });
    expect(report.checkedAt).toEqual(ctx.instant(TEST_NOW));
    expect(CheckReportSchema.parse(report)).toEqual(report);

    expect(formatCheckText(report).split('\n')[0]).toBe(
      `symbol check: OK (${TEST_NODE_HOST}, mainnet, ${ctx.instant(TEST_NOW).local})`,
    );
    expect(new Set(requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('skips the account items without --account and harvester_watch without SYMBOL_STATE_DIR', async () => {
    const { ctx, requests } = await createTestContext({ routes: routes() });
    const report = await runCheck(ctx, { account: null, warnDays: 14 });

    expect(statuses(report)).toEqual({
      node_health: 'ok',
      version_drift: 'ok',
      harvester_watch: 'skip',
      voting_key_status: 'skip',
      finality_participation: 'skip',
    });
    expect(report.exitCode).toBe(0);
    expect(report.account).toBeNull();
    expect(item(report, 'harvester_watch').detail).toBe(UNSET_NOTE);
    expect(item(report, 'voting_key_status').detail).toContain('--account');
    // Skipped items make no request: no unlocked list, no account, no proof.
    const paths = requests.map((u) => u.pathname);
    expect(paths).not.toContain('/node/unlockedaccount');
    expect(paths.some((p) => p.startsWith('/accounts/') || p.startsWith('/finalization/'))).toBe(
      false,
    );
  });

  it('is WARN with exit code 1 when /node/time is down (node_health degraded)', async () => {
    const { ctx } = await createTestContext({
      routes: routes({ 'GET /node/time': () => jsonResponse({ message: 'down' }, 503) }),
    });
    const report = await runCheck(ctx, { account: null, warnDays: 14 });

    expect(report.verdict).toBe('warn');
    expect(report.exitCode).toBe(1);
    const health = item(report, 'node_health');
    expect(health.status).toBe('warn');
    expect(health.detail).toContain('degraded (clock_skew unknown)');
    expect(health.detail).toContain('/node/time');
    expect(health.hint).toBe('Retry later; the other checks do not depend on it.');

    const text = formatCheckText(report).split('\n');
    expect(text[0]).toMatch(/^symbol check: WARN \(node\.test:3001, mainnet, 2026-09-10T03:05:00/);
    expect(text[1]).toMatch(/^\[warn\] node_health: degraded/);
    expect(text[2]).toBe('  hint: Retry later; the other checks do not depend on it.');
    expect(text[3]).toMatch(/^\[ok\] version_drift: /);
  });

  it('is FAIL with exit code 2 when /node/health answers 503 with the database down', async () => {
    const { ctx } = await createTestContext({
      routes: routes({
        'GET /node/health': () => jsonResponse({ status: { apiNode: 'up', db: 'down' } }, 503),
      }),
    });
    const report = await runCheck(ctx, { account: null, warnDays: 14 });

    expect(report.verdict).toBe('fail');
    expect(report.exitCode).toBe(2);
    const health = item(report, 'node_health');
    expect(health.status).toBe('fail');
    expect(health.detail).toBe('unhealthy (db fail). Database service is down.');
    expect(health.hint).toContain('MongoDB');
    // The other items still ran.
    expect(item(report, 'version_drift').status).toBe('ok');
    expect(formatCheckText(report).split('\n')[0]).toMatch(/^symbol check: FAIL /);
  });

  it('fails one item on a RestError and still runs the others', async () => {
    const { ctx } = await createTestContext({ routes: routes(), env: { SYMBOL_STATE_DIR: dir } });
    // /node/info answers at start-up (createTestContext) and breaks afterwards.
    const broken = routes({ 'GET /node/info': () => jsonResponse({ message: 'boom' }, 500) });
    vi.stubGlobal('fetch', createFakeFetch(broken).fetch);

    const report = await runCheck(ctx, { account: ADDRESS, warnDays: 14 });
    expect(statuses(report)).toEqual({
      node_health: 'warn', // roles unknown
      version_drift: 'fail',
      harvester_watch: 'fail',
      voting_key_status: 'ok',
      finality_participation: 'ok',
    });
    expect(report.exitCode).toBe(2);
    const drift = item(report, 'version_drift');
    expect(drift.detail).toBe('could not run: http 500 on /node/info');
    expect(drift.hint).toContain('answered HTTP 500 for /node/info');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('is ERROR with exit code 3 when the node stops answering after start-up', async () => {
    const { ctx } = await createTestContext({ routes: routes(), env: { SYMBOL_STATE_DIR: dir } });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const diagnostics: string[] = [];
    const report = await runCheck(ctx, {
      account: ADDRESS,
      warnDays: 14,
      onDiagnostic: (line) => diagnostics.push(line),
    });

    expect(report.verdict).toBe('error');
    expect(report.exitCode).toBe(3);
    expect(report.checks.map((c) => c.status)).toEqual(['fail', 'fail', 'fail', 'fail', 'fail']);
    for (const c of report.checks) expect(c.detail).toMatch(/^could not run: unreachable on \//);
    expect(report.account).toBe('NCV5HRBS…');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(`${TEST_NODE_HOST} stopped answering`);
    expect(formatCheckText(report).split('\n')[0]).toMatch(/^symbol check: ERROR /);
  });

  it('compares the unlocked harvesters with the previous run under SYMBOL_STATE_DIR', async () => {
    const unlocked = fixture<{ unlockedAccount: string[] }>('mainnet/unlockedaccount.json');
    const env = { SYMBOL_STATE_DIR: dir };

    const first = await createTestContext({ routes: routes(), env });
    const baseline = await runCheck(first.ctx, { account: null, warnDays: 14 });
    expect(item(baseline, 'harvester_watch')).toMatchObject({ status: 'ok', hint: null });
    expect(readdirSync(dir)).toHaveLength(1);

    // One delegator left: the count dropped.
    const fewer = { unlockedAccount: unlocked.unlockedAccount.slice(1) };
    const second = await createTestContext({
      routes: routes({ 'GET /node/unlockedaccount': fewer }),
      env,
      now: new Date(TEST_NOW.getTime() + 86_400_000),
    });
    // node-time is pinned to TEST_NOW, so a day later node_health reports the clock skew; only
    // the harvester item matters here.
    const dropped = await runCheck(second.ctx, { account: null, warnDays: 14 });
    const watch = item(dropped, 'harvester_watch');
    expect(watch.status).toBe('warn');
    expect(watch.detail).toContain('14 unlocked harvesters');
    expect(watch.detail).toContain('(was 15 on ');
    expect(watch.detail).toContain('+0 -1');
    expect(watch.hint).toBe(RESTART_NOTE);
    expect(dropped.exitCode).toBeGreaterThanOrEqual(1);

    // The delegator came back: growth is ok.
    const third = await createTestContext({
      routes: routes(),
      env,
      now: new Date(TEST_NOW.getTime() + 2 * 86_400_000),
    });
    const grown = item(
      await runCheck(third.ctx, { account: null, warnDays: 14 }),
      'harvester_watch',
    );
    expect(grown.status).toBe('ok');
    expect(grown.detail).toContain('+1 -0');
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it.skipIf(!posix || !notRoot)(
    'warns when the snapshot cannot be saved, with the note of the tool as the hint',
    async () => {
      chmodSync(dir, 0o500);
      const { ctx } = await createTestContext({ routes: routes(), env: { SYMBOL_STATE_DIR: dir } });
      const report = await runCheck(ctx, { account: null, warnDays: 14 });
      const watch = item(report, 'harvester_watch');
      expect(watch.status).toBe('warn');
      expect(watch.detail).toContain('NOT saved');
      expect(watch.hint?.startsWith(NOT_SAVED_NOTE_PREFIX)).toBe(true);
      expect(report.exitCode).toBe(1);
    },
  );

  it('warns about the voting key within --warn-days, with the warning of the tool as the hint', async () => {
    const { ctx } = await createTestContext({ routes: routes() });
    // The fixture key has about 27.5 days left: ok at 14 (first test), warn at 30.
    const report = await runCheck(ctx, { account: ADDRESS, warnDays: 30 });
    const voting = item(report, 'voting_key_status');
    expect(voting.status).toBe('warn');
    expect(voting.hint).toContain('Active voting key 534A99C9…');
    expect(voting.hint).toContain('no successor key is registered');
    expect(report.exitCode).toBe(1);
    expect(report.warnDays).toBe(30);
  });

  it('resolves a namespace name and reports the resolved address', async () => {
    const { ctx } = await createTestContext({ routes: routes() });
    const report = await runCheck(ctx, { account: ALIAS_NAMESPACE_NAME, warnDays: 14 });
    expect(report.account).toBe(ADDRESS);
    expect(item(report, 'voting_key_status').status).toBe('ok');
    expect(item(report, 'finality_participation').status).toBe('ok');
  });

  it('fails the account items for an account that does not exist (exit code 2, not 3)', async () => {
    const { ctx } = await createTestContext({ routes: routes() });
    // A valid mainnet address (symbol-sdk test vector) that the fixture node does not know.
    const unknown = 'NATNE7Q5BITMUTRRN6IB4I7FLSDRDWZA34SQ33Y';
    const report = await runCheck(ctx, { account: unknown, warnDays: 14 });

    expect(report.exitCode).toBe(2);
    const voting = item(report, 'voting_key_status');
    expect(voting.status).toBe('fail');
    expect(voting.detail).toMatch(/^No account with .* exists on mainnet/);
    expect(voting.hint).toContain('Check the identifier');
    expect(item(report, 'finality_participation').status).toBe('fail');
    expect(report.account).toBe('NATNE7Q5…');
  });

  it('never prints a 64-hex value that might be a private key pasted by mistake', async () => {
    const { ctx } = await createTestContext({ routes: routes() });
    const looksLikeSecret = 'DEADBEEF'.repeat(8); // treated as a public key; unknown -> 404
    const report = await runCheck(ctx, { account: looksLikeSecret, warnDays: 14 });

    expect(report.exitCode).toBe(2);
    expect(report.account).toBe('DEADBEEF…');
    expect(item(report, 'voting_key_status').detail).toContain('public key DEADBEEF…');
    expect(formatCheckJson(report)).not.toContain(looksLikeSecret);
    expect(formatCheckText(report)).not.toContain(looksLikeSecret);
  });

  it('warns (not fails) when the node has no proof for the latest epoch', async () => {
    // Default routes: the latest finalized epoch 4004 has no proof route, so the tool throws
    // ProofUnavailableError instead of returning status unavailable.
    const { ctx } = await createTestContext({ routes: mainnetRoutes() });
    const report = await runCheck(ctx, { account: ADDRESS, warnDays: 14 });
    const finality = item(report, 'finality_participation');
    expect(finality.status).toBe('warn');
    expect(finality.detail).toContain(`No finalization proof for epoch ${LATEST_EPOCH}`);
    expect(finality.hint).toBe(UNAVAILABLE_NOTE);
    expect(item(report, 'voting_key_status').status).toBe('ok');
    expect(report.exitCode).toBe(1);
  });

  it('prints the report as JSON with numbers as numbers and the Instant shape', async () => {
    const { ctx } = await createTestContext({
      routes: routes(),
      env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' },
    });
    const report = await runCheck(ctx, { account: ADDRESS, warnDays: 21 });
    const parsed = JSON.parse(formatCheckJson(report)) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      'verdict',
      'exitCode',
      'node',
      'checkedAt',
      'checks',
      'warnDays',
      'account',
    ]);
    expect(CheckReportSchema.parse(parsed)).toEqual(parsed);
    expect(parsed).toMatchObject({
      verdict: 'ok',
      exitCode: 0,
      node: { host: TEST_NODE_HOST, network: 'mainnet' },
      checkedAt: { utc: '2026-09-10T03:05:00.000Z', local: '2026-09-10T12:05:00+09:00' },
      warnDays: 21,
      account: ADDRESS,
    });
    const checks = parsed.checks as Array<Record<string, unknown>>;
    expect(checks.map((c) => Object.keys(c))).toEqual(
      CHECK_IDS.map(() => ['id', 'status', 'detail', 'hint']),
    );
    expect(checks[2]).toEqual({
      id: 'harvester_watch',
      status: 'skip',
      detail: UNSET_NOTE,
      hint: null,
    });
  });

  it('never contacts a host other than SYMBOL_NODE_URL and the reference nodes', async () => {
    const plain = await createTestContext({ routes: routes(), env: { SYMBOL_STATE_DIR: dir } });
    await runCheck(plain.ctx, { account: ALIAS_NAMESPACE_NAME, warnDays: 14 });
    expect(new Set(plain.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));

    const withRefs = await createTestContext({
      routes: routes(),
      env: { SYMBOL_REFERENCE_NODES: 'https://ref-a.test:3001,https://ref-b.test:3001' },
    });
    await runCheck(withRefs.ctx, { account: ADDRESS, warnDays: 14 });
    expect(new Set(withRefs.requests.map((u) => u.host))).toEqual(
      new Set([TEST_NODE_HOST, 'ref-a.test:3001', 'ref-b.test:3001']),
    );
    // Reference nodes are only asked for their version (symbol_version_drift).
    const refPaths = withRefs.requests
      .filter((u) => u.host !== TEST_NODE_HOST)
      .map((u) => u.pathname);
    expect(new Set(refPaths)).toEqual(new Set(['/node/info']));
  });

  it('skips what is left at the time limit and is then at best WARN', async () => {
    const { ctx } = await createTestContext({
      routes: routes({ 'GET /node/peers': () => new Promise<Response>(() => {}) }),
      env: { SYMBOL_STATE_DIR: dir },
    });
    const diagnostics: string[] = [];
    const report = await runCheck(ctx, {
      account: ADDRESS,
      warnDays: 14,
      timeLimitMs: 300,
      onDiagnostic: (line) => diagnostics.push(line),
    });

    expect(report.checks.map((c) => c.status)).toEqual(['ok', 'skip', 'skip', 'skip', 'skip']);
    expect(item(report, 'version_drift').detail).toBe(
      'time limit of 300 ms reached while this check was running',
    );
    expect(item(report, 'harvester_watch').detail).toBe(
      'time limit of 300 ms reached before this check ran',
    );
    expect(report.verdict).toBe('warn');
    expect(report.exitCode).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('4 check(s) skipped');
    // Nothing was written by the items that never ran.
    expect(readdirSync(dir)).toEqual([]);
  });
});
