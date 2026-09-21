/**
 * The pure half of `symbol-mcp-server check`: how each tool's verdict is re-read as a check
 * status, how the exit code is decided, the --warn-days boundaries, argument parsing, and the text
 * rendering. test/tools/cli_check.test.ts runs the whole check against the fixture node.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CheckItemStatus,
  type CheckReport,
  DEFAULT_WARN_DAYS,
  decideExit,
  type FinalityView,
  type HarvesterWatchView,
  mapFinality,
  mapHarvesterWatch,
  mapNodeHealth,
  mapVersionDrift,
  mapVotingKeys,
  type NodeHealthView,
  type VotingKeysView,
} from '../../src/cli/check.js';
import { formatCheckJson, formatCheckText } from '../../src/cli/format.js';
import { type CliDeps, parseCliArgs, runCli } from '../../src/cli.js';
import { UNAVAILABLE_NOTE } from '../../src/tools/symbol_finality_participation.js';
import { NOT_SAVED_NOTE_PREFIX, RESTART_NOTE } from '../../src/tools/symbol_harvester_watch.js';
import { createFakeFetch, jsonResponse, mainnetRoutes, TEST_NOW } from '../tools/harness.js';

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';

describe('mapNodeHealth', () => {
  const okCheck = {
    id: 'db',
    status: 'ok',
    detail: 'Database service is up.',
    hint: null,
  } as const;
  const chain = { height: 1_000, finalizedHeight: 988 };

  it('reads healthy as ok and shows the finalization lag', () => {
    expect(mapNodeHealth({ verdict: 'healthy', checks: [okCheck], chain })).toEqual({
      status: 'ok',
      detail: 'healthy (finalization lag 12 blocks)',
      hint: null,
    });
    expect(mapNodeHealth({ verdict: 'healthy', checks: [okCheck], chain: null }).detail).toBe(
      'healthy',
    );
  });

  it('reads degraded as warn and passes the hint of the check that is not ok', () => {
    const view: NodeHealthView = {
      verdict: 'degraded',
      checks: [
        okCheck,
        { id: 'clock_skew', status: 'unknown', detail: 'no /node/time.', hint: 'Retry later.' },
      ],
      chain,
    };
    expect(mapNodeHealth(view)).toEqual({
      status: 'warn',
      detail: 'degraded (clock_skew unknown). no /node/time.',
      hint: 'Retry later.',
    });
  });

  it('reads unhealthy as fail and prefers the failing check over an earlier warning', () => {
    const view: NodeHealthView = {
      verdict: 'unhealthy',
      checks: [
        { id: 'storage_consistent', status: 'warn', detail: 'storage off.', hint: 'storage hint' },
        { id: 'clock_skew', status: 'unknown', detail: 'no time.', hint: 'time hint' },
        { id: 'db', status: 'fail', detail: 'Database service is down.', hint: 'db hint' },
        { id: 'api_node', status: 'fail', detail: 'API node is down.', hint: 'api hint' },
      ],
      chain,
    };
    const item = mapNodeHealth(view);
    expect(item.status).toBe('fail');
    expect(item.hint).toBe('db hint');
    expect(item.detail).toBe(
      'unhealthy (storage_consistent warn, clock_skew unknown, db fail, api_node fail). Database service is down.',
    );
  });
});

describe('mapVersionDrift', () => {
  const cases: ReadonlyArray<
    readonly ['ok' | 'behind' | 'far_behind' | 'unknown', CheckItemStatus]
  > = [
    ['ok', 'ok'],
    ['behind', 'warn'],
    ['far_behind', 'fail'],
    ['unknown', 'warn'],
  ];
  it.each(cases)('reads %s as %s', (verdict, status) => {
    expect(mapVersionDrift({ verdict, summary: `version drift: ${verdict}.` }).status).toBe(status);
  });

  it('uses the first summary line as the detail and the advice line as the hint', () => {
    const item = mapVersionDrift({
      verdict: 'behind',
      summary:
        'version drift: BEHIND the majority. node runs 1.0.3.8; majority runs 1.0.4.0.\n- Newer versions are taking over: plan the upgrade.',
    });
    expect(item).toEqual({
      status: 'warn',
      detail: 'BEHIND the majority. node runs 1.0.3.8; majority runs 1.0.4.0.',
      hint: 'Newer versions are taking over: plan the upgrade.',
    });
    expect(mapVersionDrift({ verdict: 'ok', summary: 'version drift: ok. fine.' }).hint).toBeNull();
  });
});

describe('mapHarvesterWatch', () => {
  const notSaved = `${NOT_SAVED_NOTE_PREFIX} could not write /x (EACCES). Check SYMBOL_STATE_DIR.`;
  const view = (over: Partial<HarvesterWatchView>): HarvesterWatchView => ({
    summary: '15 unlocked harvesters on node.test:3001 (was 16 on t): +0 -1. Snapshot saved.',
    comparison: { deltaCount: -1 },
    saved: true,
    notes: ['first note', RESTART_NOTE],
    ...over,
  });

  it('warns when the count dropped, with the restart note of the tool as the hint', () => {
    const item = mapHarvesterWatch(view({}));
    expect(item.status).toBe('warn');
    expect(item.detail).toContain('+0 -1');
    expect(item.hint).toBe(RESTART_NOTE);
  });

  it('is ok when the count is unchanged or grew, and for a baseline', () => {
    for (const comparison of [{ deltaCount: 0 }, { deltaCount: 3 }, null]) {
      expect(mapHarvesterWatch(view({ comparison }))).toMatchObject({ status: 'ok', hint: null });
    }
  });

  it('warns when the snapshot could not be saved, whatever the delta', () => {
    for (const comparison of [{ deltaCount: 2 }, { deltaCount: -2 }, null]) {
      const item = mapHarvesterWatch(
        view({ comparison, saved: false, notes: [RESTART_NOTE, notSaved] }),
      );
      expect(item).toMatchObject({ status: 'warn', hint: notSaved });
    }
  });
});

describe('mapVotingKeys and --warn-days', () => {
  const KEY = 'B'.repeat(64);
  const warning = `Active voting key ${KEY.slice(0, 8)}… expires at epoch 4059 in about 14 days and no successor key is registered.`;
  const active = (
    remainingDays: number,
    over: Partial<VotingKeysView['votingKeys'][number]> = {},
  ) =>
    ({
      publicKey: KEY,
      status: 'active',
      startEpoch: 3700,
      endEpoch: 4059,
      remainingDays,
      expiresAt: { utc: '2026-10-01T00:00:00.000Z' },
      ...over,
    }) as const;
  const expired = {
    publicKey: 'A'.repeat(64),
    status: 'expired',
    startEpoch: 3340,
    endEpoch: 3699,
  } as const;
  const status = (days: number, warnDays = DEFAULT_WARN_DAYS) =>
    mapVotingKeys({ votingKeys: [expired, active(days)], warnings: [warning] }, warnDays).status;

  it('warns at exactly warn-days and is ok above it', () => {
    expect(status(14)).toBe('warn');
    expect(status(14.1)).toBe('ok');
    expect(status(15)).toBe('ok');
    expect(status(30, 30)).toBe('warn');
    expect(status(30.1, 30)).toBe('ok');
  });

  it('fails at 3 days or less (the end of the recommended renewal window)', () => {
    expect(status(3.1)).toBe('warn');
    expect(status(3)).toBe('fail');
    expect(status(0)).toBe('fail');
    // A --warn-days below the window leaves no warn band: ok down to 3.1, then fail.
    expect(status(3.1, 1)).toBe('ok');
    expect(status(3, 1)).toBe('fail');
  });

  it('fails when no key is active (expired only, future only, none)', () => {
    const future = { ...expired, status: 'future', startEpoch: 4100, endEpoch: 4400 } as const;
    const none = 'No active voting key is registered for this account.';
    expect(mapVotingKeys({ votingKeys: [expired], warnings: [none] }, 14)).toEqual({
      status: 'fail',
      detail: 'no active voting key (1 registered: 0 future, 1 expired)',
      hint: none,
    });
    expect(mapVotingKeys({ votingKeys: [expired, future], warnings: [] }, 14)).toMatchObject({
      status: 'fail',
      detail: 'no active voting key (2 registered: 1 future, 1 expired)',
      hint: null,
    });
    expect(mapVotingKeys({ votingKeys: [], warnings: [none] }, 14).status).toBe('fail');
  });

  it('is ok when a successor key follows without a gap, even inside the last 3 days', () => {
    const successor = { ...expired, status: 'future', startEpoch: 4060, endEpoch: 4400 } as const;
    const item = mapVotingKeys({ votingKeys: [active(2), successor], warnings: [] }, 14);
    expect(item.status).toBe('ok');
    expect(item.detail).toContain('successor registered');
    expect(item.detail).toContain('about 2 days');
    expect(item.hint).toBeNull();
    // One epoch of gap is not a successor.
    const late = { ...successor, startEpoch: 4061 };
    expect(mapVotingKeys({ votingKeys: [active(2), late], warnings: [] }, 14).status).toBe('fail');
  });

  it('judges the active key with the most days left', () => {
    const short = active(2, { publicKey: 'C'.repeat(64), endEpoch: 4010 });
    const item = mapVotingKeys({ votingKeys: [short, active(40)], warnings: [] }, 14);
    expect(item.status).toBe('ok');
    expect(item.detail).toContain(`${KEY.slice(0, 8)}…`);
  });

  it('takes the hint from the tool warning about that key, and has none when the tool is silent', () => {
    const other = 'All 3 voting key slots are used (1 expired).';
    const item = mapVotingKeys({ votingKeys: [active(10)], warnings: [other, warning] }, 14);
    expect(item).toMatchObject({ status: 'warn', hint: warning });
    expect(item.detail).toBe(
      `active key ${KEY.slice(0, 8)}… expires in about 10 days (epoch 4059, estimated 2026-10-01T00:00:00.000Z)`,
    );
    // The tool warns from 30 days; a larger --warn-days warns earlier, without a tool text.
    expect(mapVotingKeys({ votingKeys: [active(45)], warnings: [other] }, 60)).toMatchObject({
      status: 'warn',
      hint: null,
    });
  });
});

describe('mapFinality', () => {
  const view = (
    status: FinalityView['epochs'][number]['status'],
    over: Partial<FinalityView> = {},
  ): FinalityView => ({
    epochs: [{ epoch: 4004, status }],
    warning: null,
    notes: ['first note', UNAVAILABLE_NOTE],
    ...over,
  });
  const cases: ReadonlyArray<readonly [FinalityView['epochs'][number]['status'], CheckItemStatus]> =
    [
      ['participated', 'ok'],
      ['missed', 'warn'],
      ['no_active_key', 'fail'],
      ['unavailable', 'warn'],
    ];
  it.each(cases)('reads %s as %s', (toolStatus, expected) => {
    expect(mapFinality(view(toolStatus)).status).toBe(expected);
  });

  it('describes the epoch and passes the warning of the tool as the hint', () => {
    expect(mapFinality(view('participated', { warning: 'ignored when ok' }))).toEqual({
      status: 'ok',
      detail: 'epoch 4004: participated',
      hint: null,
    });
    const missed = mapFinality({
      epochs: [
        {
          epoch: 4004,
          status: 'missed',
          stages: [
            { stageName: 'prevote', participated: true },
            { stageName: 'precommit', participated: false },
          ],
        },
      ],
      warning: 'The account did not vote in the current epoch.',
      notes: [],
    });
    expect(missed).toEqual({
      status: 'warn',
      detail: 'epoch 4004: missed (signed prevote only)',
      hint: 'The account did not vote in the current epoch.',
    });
    expect(mapFinality(view('no_active_key', { warning: 'no key' }))).toEqual({
      status: 'fail',
      detail: 'epoch 4004: no active key',
      hint: 'no key',
    });
  });

  it('explains unavailable with the note of the tool', () => {
    expect(mapFinality(view('unavailable'))).toEqual({
      status: 'warn',
      detail: 'epoch 4004: proof unavailable',
      hint: UNAVAILABLE_NOTE,
    });
    expect(mapFinality({ epochs: [], warning: null, notes: [] }).status).toBe('warn');
  });
});

describe('decideExit', () => {
  const of = (...statuses: CheckItemStatus[]) => statuses.map((status) => ({ status }));

  it('is 0 when everything is ok or skipped', () => {
    expect(decideExit(of('ok', 'ok', 'skip', 'skip', 'skip'))).toEqual({
      verdict: 'ok',
      exitCode: 0,
    });
    expect(decideExit(of('skip'))).toEqual({ verdict: 'ok', exitCode: 0 });
  });
  it('is 1 with a warning and no failure', () => {
    expect(decideExit(of('ok', 'warn', 'skip'))).toEqual({ verdict: 'warn', exitCode: 1 });
  });
  it('is 2 as soon as one item fails', () => {
    expect(decideExit(of('warn', 'fail', 'ok'))).toEqual({ verdict: 'fail', exitCode: 2 });
  });
  it('is at best a warning when the time limit cut the run short', () => {
    expect(decideExit(of('ok', 'skip', 'skip'), { timedOut: true })).toEqual({
      verdict: 'warn',
      exitCode: 1,
    });
    expect(decideExit(of('fail', 'skip'), { timedOut: true }).exitCode).toBe(2);
  });
  it('is 3 when the node could not be reached by any item that ran', () => {
    expect(decideExit(of('fail', 'fail', 'skip'), { nodeUnreachable: true })).toEqual({
      verdict: 'error',
      exitCode: 3,
    });
  });
});

describe('parseCliArgs: check', () => {
  const options = (argv: string[]) => {
    const cli = parseCliArgs(['check', ...argv]);
    if (cli.mode !== 'check') throw new Error(`expected check, got ${JSON.stringify(cli)}`);
    return cli.options;
  };
  const usage = (argv: string[]) => {
    const cli = parseCliArgs(['check', ...argv]);
    if (cli.mode !== 'check_usage') throw new Error(`expected usage, got ${JSON.stringify(cli)}`);
    return cli.message;
  };

  it('has defaults', () => {
    expect(options([])).toEqual({ account: null, warnDays: 14, format: 'text', quiet: false });
  });

  it('accepts --flag value and --flag=value, in any order', () => {
    expect(
      options(['--quiet', '--account', ADDRESS, '--warn-days', '30', '--format', 'json']),
    ).toEqual({ account: ADDRESS, warnDays: 30, format: 'json', quiet: true });
    expect(options([`--account=${ADDRESS}`, '--warn-days=1', '--format=text'])).toEqual({
      account: ADDRESS,
      warnDays: 1,
      format: 'text',
      quiet: false,
    });
    expect(options(['--warn-days', '120']).warnDays).toBe(120);
  });

  it('accepts a public key and a namespace name as the account', () => {
    expect(options(['--account', 'A'.repeat(64)]).account).toBe('A'.repeat(64));
    expect(options(['--account', 'alice.pay']).account).toBe('alice.pay');
  });

  it('rejects --warn-days outside 1 to 120 or not a whole number', () => {
    for (const bad of ['0', '121', '14.5', '1e1', '-3', 'ten', '0x10', ' 14']) {
      expect(usage(['--warn-days', bad])).toContain('--warn-days must be a whole number');
    }
  });

  it('rejects an unknown format, flag, positional argument and account', () => {
    expect(usage(['--format', 'yaml'])).toContain('--format must be text or json');
    expect(usage(['--node-url', 'https://x'])).toContain('unknown argument "--node-url"');
    expect(usage(['now'])).toContain('unknown argument "now"');
    expect(usage(['--account', 'Not An Account'])).toContain('not a valid Symbol account');
    // A long invalid value is masked, the same way tool errors do it.
    expect(usage(['--account', `${'Z'.repeat(64)}`])).not.toContain('Z'.repeat(9));
  });

  it('rejects a missing value, a repeated flag and a value on --quiet', () => {
    expect(usage(['--account'])).toContain('--account needs a value');
    expect(usage(['--account', '--quiet'])).toContain('--account needs a value');
    expect(usage(['--warn-days='])).toContain('--warn-days needs a value');
    expect(usage(['--format', 'json', '--format=text'])).toContain('more than once');
    expect(usage(['--quiet=1'])).toContain('--quiet takes no value');
  });

  it('shows the general help for check --help', () => {
    expect(parseCliArgs(['check', '--help'])).toEqual({ mode: 'help' });
    expect(parseCliArgs(['check', '--quiet', '-h'])).toEqual({ mode: 'help' });
  });
});

describe('runCli check', () => {
  afterEach(() => vi.unstubAllGlobals());

  function deps(over: Partial<CliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const cliDeps: CliDeps = {
      env: { SYMBOL_NODE_URL: 'https://node.test:3001' },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      serve: vi.fn(async () => {}),
      version: '0.0.0-test',
      now: () => TEST_NOW,
      ...over,
    };
    return { cliDeps, out, err };
  }

  it('exits 3 on a usage error with a two-line hint, before any request', async () => {
    const fake = createFakeFetch(mainnetRoutes());
    vi.stubGlobal('fetch', fake.fetch);
    const { cliDeps, out, err } = deps();
    expect(await runCli(['check', '--warn-days', '0'], cliDeps)).toBe(3);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]?.split('\n')).toHaveLength(2);
    expect(err[0]).toContain('symbol-mcp-server check: --warn-days must be');
    expect(err[0]).toContain('--help');
    expect(fake.requests).toEqual([]);
  });

  it('exits 3 on a configuration error and when the node cannot be reached', async () => {
    const fake = createFakeFetch(mainnetRoutes());
    vi.stubGlobal('fetch', fake.fetch);
    const missing = deps({ env: {} });
    expect(await runCli(['check'], missing.cliDeps)).toBe(3);
    expect(missing.out).toEqual([]);
    expect(missing.err.join('\n')).toContain('SYMBOL_NODE_URL is required');
    expect(fake.requests).toEqual([]);

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const down = deps();
    expect(await runCli(['check', '--format', 'json'], down.cliDeps)).toBe(3);
    expect(down.out).toEqual([]);
    expect(down.err).toHaveLength(1);
    expect(down.err[0]?.split('\n')).toHaveLength(2);
    expect(down.err[0]).toContain('could not read /node/info from node.test:3001 (unreachable)');
  });

  it('prints nothing with --quiet when the exit code is 0', async () => {
    vi.stubGlobal('fetch', createFakeFetch(mainnetRoutes()).fetch);
    const quiet = deps();
    expect(await runCli(['check', '--quiet'], quiet.cliDeps)).toBe(0);
    expect(quiet.out).toEqual([]);
    expect(quiet.err).toEqual([]);

    const loud = deps();
    expect(await runCli(['check'], loud.cliDeps)).toBe(0);
    expect(loud.out.join('')).toMatch(/^symbol check: OK \(node\.test:3001, mainnet, /);
  });

  it('still prints with --quiet when the exit code is not 0', async () => {
    const routes = {
      ...mainnetRoutes(),
      'GET /node/time': () => jsonResponse({ message: 'unavailable' }, 503),
    };
    vi.stubGlobal('fetch', createFakeFetch(routes).fetch);
    const { cliDeps, out } = deps();
    expect(await runCli(['check', '--quiet'], cliDeps)).toBe(1);
    expect(out.join('')).toMatch(/^symbol check: WARN /);
  });
});

describe('formatCheckText and formatCheckJson', () => {
  const report: CheckReport = {
    verdict: 'fail',
    exitCode: 2,
    node: { host: 'node.test:3001', network: 'mainnet' },
    checkedAt: { utc: '2026-09-10T03:05:00.000Z', local: '2026-09-10T12:05:00+09:00' },
    checks: [
      { id: 'node_health', status: 'ok', detail: 'healthy', hint: 'never shown for ok' },
      { id: 'version_drift', status: 'warn', detail: 'BEHIND the majority.', hint: 'Plan it.' },
      { id: 'harvester_watch', status: 'skip', detail: 'not set', hint: null },
      { id: 'voting_key_status', status: 'fail', detail: 'no active\nvoting key', hint: null },
      { id: 'finality_participation', status: 'fail', detail: 'no key', hint: 'two\n lines' },
    ],
    warnDays: 14,
    account: ADDRESS,
  };

  it('prints the verdict line, one line per item, and a hint line under warn and fail', () => {
    expect(formatCheckText(report)).toBe(
      [
        'symbol check: FAIL (node.test:3001, mainnet, 2026-09-10T12:05:00+09:00)',
        '[ok] node_health: healthy',
        '[warn] version_drift: BEHIND the majority.',
        '  hint: Plan it.',
        '[skip] harvester_watch: not set',
        '[fail] voting_key_status: no active voting key',
        '[fail] finality_participation: no key',
        '  hint: two lines',
        '',
      ].join('\n'),
    );
  });

  it('falls back to UTC without a time zone and uses no escape sequences', () => {
    const utc = formatCheckText({ ...report, checkedAt: { utc: '2026-09-10T03:05:00.000Z' } });
    expect(utc.split('\n')[0]).toBe(
      'symbol check: FAIL (node.test:3001, mainnet, 2026-09-10T03:05:00.000Z)',
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is exactly what we check for
    expect(utc).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  it('prints the report itself as one JSON document', () => {
    expect(JSON.parse(formatCheckJson(report))).toEqual(report);
    expect(formatCheckJson(report).endsWith('}\n')).toBe(true);
  });
});

describe('src/cli/', () => {
  it('imports nothing from the MCP SDK, so it can move to its own package', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['check.ts', 'format.ts']);
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/from\s+'@modelcontextprotocol/);
    }
  });
});
