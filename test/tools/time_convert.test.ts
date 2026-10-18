import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DATE_MS } from '../../src/domain/time.js';
import { unusableTimeText } from '../../src/tools/_shared.js';
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

const CURRENT_HEIGHT = 5_763_675;

describe('symbol_time_convert', () => {
  it('converts a past height exactly using the block timestamp', async () => {
    server = await startTestServer({ env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' } });
    const result = await server.callTool('symbol_time_convert', { height: CURRENT_HEIGHT });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      input: { kind: 'height', value: CURRENT_HEIGHT },
      height: CURRENT_HEIGHT,
      epoch: 4004,
      epochRange: { startHeight: 5_762_881, endHeight: 5_764_320 },
      networkTimestampMs: 173_156_113_808,
      time: { utc: '2026-09-10T03:01:38.808Z', local: '2026-09-10T12:01:38+09:00' },
      epochEnd: null,
      isEstimate: false,
      current: { height: CURRENT_HEIGHT, finalizationEpoch: 4004, votingSetGrouping: 1440 },
    });
    expect(result.structuredContent?.summary).toMatch(
      /was produced at 2026-09-10T12:01:38\+09:00 \(2026-09-10T03:01:38\.808Z\)/,
    );
    expect(result.structuredContent?.method).toMatch(/^Exact/);
  });

  it('estimates a future height from the measured block time', async () => {
    server = await startTestServer();
    const target = CURRENT_HEIGHT + 1000;
    const result = await server.callTool('symbol_time_convert', { height: target });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.isEstimate).toBe(true);
    expect((sc.time as { utc: string }).utc).toBe(
      new Date(TEST_NOW.getTime() + 1000 * 30_030).toISOString(),
    );
    expect(sc.method).toMatch(/Estimated.*30\.03s/);
    expect(sc.summary).toMatch(/is expected around/);
    expect(server.requests.some((u) => u.pathname === `/blocks/${target}`)).toBe(false);
  });

  it('converts an epoch to its height range and start/end times', async () => {
    const startBlock = fixture<{ block: Record<string, unknown> }>('mainnet/block-5763675.json');
    startBlock.block.height = '5762881';
    startBlock.block.timestamp = '173132000000';
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /blocks/5762881': startBlock },
    });
    const result = await server.callTool('symbol_time_convert', { epoch: 4004 });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      input: { kind: 'epoch', value: 4004 },
      height: 5_762_881,
      epoch: 4004,
      epochRange: { startHeight: 5_762_881, endHeight: 5_764_320 },
      networkTimestampMs: 173_132_000_000,
      isEstimate: true, // the end height is in the future
    });
    const epochEnd = sc.epochEnd as { height: number; time: { utc: string } };
    expect(epochEnd.height).toBe(5_764_320);
    expect(epochEnd.time.utc).toBe(
      new Date(TEST_NOW.getTime() + (5_764_320 - CURRENT_HEIGHT) * 30_030).toISOString(),
    );
    expect(sc.summary).toMatch(
      /Epoch 4004 on mainnet \(current; current finalization epoch 4004\) covers heights 5,762,881-5,764,320/,
    );
  });

  it('converts a network timestamp to wall-clock time and an estimated height', async () => {
    server = await startTestServer({ env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' } });
    const result = await server.callTool('symbol_time_convert', { timestamp: 173_156_113_808 });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.time).toEqual({
      utc: '2026-09-10T03:01:38.808Z',
      local: '2026-09-10T12:01:38+09:00',
    });
    // 201.2 s before TEST_NOW at 30.03 s/block is about 7 blocks back.
    expect(sc.height).toBe(CURRENT_HEIGHT - 7);
    expect(sc.epoch).toBe(4004);
    expect(sc.isEstimate).toBe(true);
    expect(sc.summary).toMatch(/epoch adjustment 1615853185s/);
  });

  it('requires exactly one input', async () => {
    server = await startTestServer();
    const none = await server.callTool('symbol_time_convert', {});
    expect(none.isError).toBe(true);
    const two = await server.callTool('symbol_time_convert', { height: 1, epoch: 1 });
    expect(two.isError).toBe(true);
    const bad = await server.callTool('symbol_time_convert', { height: 0 });
    expect(bad.isError).toBe(true);
  });
});

describe('symbol_time_convert: a value too large to give a date', () => {
  afterEach(() => vi.restoreAllMocks());

  // The input schema bounds the values above only by the safe integers. With the fixtures (epoch adjustment
  // 1615853185 s, measured average 30.03 s, target 30 s), counted from TEST_NOW:
  const EPOCH_ADJUSTMENT_MS = 1_615_853_185_000;
  const LAST_TIMESTAMP = MAX_DATE_MS - EPOCH_ADJUSTMENT_MS; // 8638384146815000
  const NOW_TIMESTAMP = TEST_NOW.getTime() - EPOCH_ADJUSTMENT_MS; // 173156315000
  /** The last height whose estimate is a date, by the measured average and by the target. */
  const LAST_HEIGHT_MEASURED = 287_658_477_311;
  const LAST_HEIGHT_TARGET = 287_946_130_025;
  /** The last epochs whose last height is at or below those heights. */
  const LAST_EPOCH_MEASURED = 199_762_832;
  const LAST_EPOCH_TARGET = 199_962_591;
  const NODE_TEXT = unusableTimeText(TEST_NODE_HOST);

  const call = async (args: Record<string, unknown>) => {
    if (server === undefined) server = await startTestServer();
    return server.callTool('symbol_time_convert', args);
  };
  const blockRequests = () =>
    (server?.requests ?? []).map((u) => u.pathname).filter((p) => p.startsWith('/blocks/'));

  it('checks the boundary values this test uses', () => {
    const estimate = (height: number, blockTimeMs: number) =>
      TEST_NOW.getTime() + (height - CURRENT_HEIGHT) * blockTimeMs;
    expect(estimate(LAST_HEIGHT_MEASURED, 30_030)).toBeLessThanOrEqual(MAX_DATE_MS);
    expect(estimate(LAST_HEIGHT_MEASURED + 1, 30_030)).toBeGreaterThan(MAX_DATE_MS);
    expect(estimate(LAST_HEIGHT_TARGET, 30_000)).toBeLessThanOrEqual(MAX_DATE_MS);
    expect(estimate(LAST_HEIGHT_TARGET + 1, 30_000)).toBeGreaterThan(MAX_DATE_MS);
    expect((LAST_EPOCH_MEASURED - 1) * 1440).toBeLessThanOrEqual(LAST_HEIGHT_MEASURED);
    expect(LAST_EPOCH_MEASURED * 1440).toBeGreaterThan(LAST_HEIGHT_MEASURED);
    expect((LAST_EPOCH_TARGET - 1) * 1440).toBeLessThanOrEqual(LAST_HEIGHT_TARGET);
    expect(LAST_EPOCH_TARGET * 1440).toBeGreaterThan(LAST_HEIGHT_TARGET);
  });

  it('answers a timestamp beyond the last date with an input error that gives the current one', async () => {
    const result = await call({ timestamp: 9_000_000_000_000_000 });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'timestamp 9000000000000000 ms is beyond the last time that can be shown as a date. Pass a network timestamp in milliseconds since the network epoch (as in block.timestamp); the current one is about 173156315000 ms.',
    );
    expect(NOW_TIMESTAMP).toBe(173_156_315_000);
    expect(result.structuredContent).toBeUndefined();
  });

  it('accepts the last timestamp that gives a date, and not the next one', async () => {
    expect(LAST_TIMESTAMP).toBe(8_638_384_146_815_000);
    const last = await call({ timestamp: LAST_TIMESTAMP });
    expect(last.isError).toBe(false);
    expect(last.structuredContent?.time).toEqual({ utc: '+275760-09-13T00:00:00.000Z' });
    const next = await call({ timestamp: LAST_TIMESTAMP + 1 });
    expect(next.isError).toBe(true);
    expect(next.text).toMatch(
      /^timestamp 8638384146815001 ms is beyond the last time that can be shown as a date\. /,
    );
  });

  it('answers a height too far in the future with an input error, once the average block time is measured', async () => {
    const result = await call({ height: 1_000_000_000_000 });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'height 1,000,000,000,000 is too far in the future to estimate a date (the current height is 5,763,675). Pass a height closer to the current one.',
    );
    // The two blocks of the average were read first: the node's values come before the judgement.
    expect(blockRequests()).toEqual(['/blocks/5753675', '/blocks/5763675']);
  });

  it('estimates the last height that gives a date; beyond it the caller is at fault only when the target block time gives none either', async () => {
    const last = await call({ height: LAST_HEIGHT_MEASURED });
    expect(last.isError).toBe(false);
    expect(last.structuredContent).toMatchObject({
      isEstimate: true,
      time: { utc: '+275760-09-12T23:59:49.080Z' },
    });
    // Between the two limits the measured average gives no date and the target would: the block
    // times are the node's, so the answer is the node's text, not an input error.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const height of [LAST_HEIGHT_MEASURED + 1, LAST_HEIGHT_TARGET]) {
      const between = await call({ height });
      expect(between.isError).toBe(true);
      expect(between.text).toBe(NODE_TEXT);
    }
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      `symbol-mcp-server: unusable time from node ${TEST_NODE_HOST}: InvalidDateError: the date holds no valid time (outside the range of Date)`,
      `symbol-mcp-server: unusable time from node ${TEST_NODE_HOST}: InvalidDateError: the date holds no valid time (outside the range of Date)`,
    ]);
    const beyond = await call({ height: LAST_HEIGHT_TARGET + 1 });
    expect(beyond.isError).toBe(true);
    expect(beyond.text).toBe(
      'height 287,946,130,026 is too far in the future to estimate a date (the current height is 5,763,675). Pass a height closer to the current one.',
    );
  });

  it('answers an epoch too far in the future with an input error', async () => {
    const result = await call({ epoch: 1_000_000_000 });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'epoch 1000000000 is too far in the future to estimate a date (the current finalization epoch is 4004). Pass an epoch closer to the current one.',
    );
    expect(blockRequests()).toEqual(['/blocks/5753675', '/blocks/5763675']);
  });

  it('answers an epoch whose heights are not safe integers with the same input error', async () => {
    const result = await call({ epoch: Number.MAX_SAFE_INTEGER });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'epoch 9007199254740991 is too far in the future to estimate a date (the current finalization epoch is 4004). Pass an epoch closer to the current one.',
    );
    await server?.close();

    // That epoch is also too far for a date. With two blocks 1 ms apart the average is so small
    // that a date could be estimated for an epoch whose last height is not a safe integer: the
    // height would not be exact, so it is refused all the same.
    const older = fixture<{ block: Record<string, unknown> }>('mainnet/block-5753675.json');
    older.block.timestamp = '173156113807';
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /blocks/5753675': older },
    });
    expect(Number.isSafeInteger((6_300_000_000_000 - 1) * 1440)).toBe(false);
    const unsafe = await server.callTool('symbol_time_convert', { epoch: 6_300_000_000_000 });
    expect(unsafe.isError).toBe(true);
    expect(unsafe.text).toBe(
      'epoch 6300000000000 is too far in the future to estimate a date (the current finalization epoch is 4004). Pass an epoch closer to the current one.',
    );
    // An epoch with safe heights is estimated there.
    const safe = await server.callTool('symbol_time_convert', { epoch: 6_000_000_000_000 });
    expect(safe.isError, safe.text).toBe(false);
  });

  it('takes a height the target block time cannot date when the measured average can', async () => {
    // A chain that runs faster than the target: 29.97 s measured, 30 s target. The limit of the
    // measured average then lies beyond that of the target, and there is no band between them.
    const older = fixture<{ block: Record<string, unknown> }>('mainnet/block-5753675.json');
    older.block.timestamp = '172856413808';
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /blocks/5753675': older },
    });
    const lastMeasured = 288_234_358_619;
    expect(TEST_NOW.getTime() + (lastMeasured - CURRENT_HEIGHT) * 29_970).toBeLessThanOrEqual(
      MAX_DATE_MS,
    );
    expect(TEST_NOW.getTime() + (lastMeasured + 1 - CURRENT_HEIGHT) * 29_970).toBeGreaterThan(
      MAX_DATE_MS,
    );
    const beyondTarget = await server.callTool('symbol_time_convert', {
      height: LAST_HEIGHT_TARGET + 1,
    });
    expect(beyondTarget.isError, beyondTarget.text).toBe(false);
    expect(beyondTarget.structuredContent).toMatchObject({
      isEstimate: true,
      time: { utc: '+275486-12-19T16:57:19.470Z' },
    });
    const beyondBoth = await server.callTool('symbol_time_convert', { height: lastMeasured + 1 });
    expect(beyondBoth.isError).toBe(true);
    expect(beyondBoth.text).toBe(
      'height 288,234,358,620 is too far in the future to estimate a date (the current height is 5,763,675). Pass a height closer to the current one.',
    );
  });

  it('does not blame the caller when the node gives no block time to judge with', async () => {
    // No average can be measured (the two blocks have one time) and the target is 0: nothing
    // says that the next height is too far. That node is beyond what this change words.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const older = fixture<{ block: Record<string, unknown> }>('mainnet/block-5753675.json');
    older.block.timestamp = '173156113808';
    const properties = fixture<{ chain: Record<string, string> }>(
      'mainnet/network-properties.json',
    );
    properties.chain.blockGenerationTargetTime = '0s';
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        'GET /blocks/5753675': older,
        'GET /network/properties': properties,
      },
    });
    const result = await server.callTool('symbol_time_convert', { height: CURRENT_HEIGHT + 1 });
    expect(result.isError).toBe(true);
    expect(result.text).not.toMatch(/too far in the future/);
    expect(result.text).toMatch(/^Unexpected internal error/);
    await server.close();

    // With a measured average and a target of 0, the average alone judges the value.
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /network/properties': properties },
    });
    const far = await server.callTool('symbol_time_convert', { height: 1_000_000_000_000 });
    expect(far.isError).toBe(true);
    expect(far.text).toMatch(/^height 1,000,000,000,000 is too far in the future /);
  });

  it('estimates the last epoch that gives a date, and draws the same line for epochs as for heights', async () => {
    const last = await call({ epoch: LAST_EPOCH_MEASURED });
    expect(last.isError).toBe(false);
    expect(last.structuredContent).toMatchObject({
      isEstimate: true,
      epochRange: { startHeight: 287_658_475_201, endHeight: 287_658_476_640 },
      epochEnd: { height: 287_658_476_640, time: { utc: '+275760-09-12T18:23:58.950Z' } },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const epoch of [LAST_EPOCH_MEASURED + 1, LAST_EPOCH_TARGET]) {
      const between = await call({ epoch });
      expect(between.isError).toBe(true);
      expect(between.text).toBe(NODE_TEXT);
    }
    const beyond = await call({ epoch: LAST_EPOCH_TARGET + 1 });
    expect(beyond.isError).toBe(true);
    expect(beyond.text).toMatch(/^epoch 199962592 is too far in the future to estimate a date /);
  });

  it('blames the node, not the caller, when a block time the average is measured from cannot be used', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Beyond the range of a date, up to the largest uint64, which the schema accepts.
    for (const timestamp of ['9000000000000000', '18446744073709551615']) {
      const latest = fixture<{ block: Record<string, unknown> }>('mainnet/block-5763675.json');
      latest.block.timestamp = timestamp;
      server = await startTestServer({
        routes: { ...mainnetRoutes(), 'GET /blocks/5763675': latest },
      });
      // An ordinary value, and one that would be the caller's fault with a usable block time.
      for (const args of [{ timestamp: 173_156_113_808 }, { timestamp: 9_000_000_000_000_000 }]) {
        const result = await server.callTool('symbol_time_convert', args);
        expect(result.isError).toBe(true);
        expect(result.text).toBe(NODE_TEXT);
        expect(result.text).not.toMatch(/^timestamp /);
      }
      await server.close();
      server = undefined;
    }
    // The value goes to stderr, as the node sent it.
    const logged = errors.mock.calls.map((c) => String(c[0]));
    const prefix = `symbol-mcp-server: unusable time from node ${TEST_NODE_HOST}: InvalidNetworkTimestampError: invalid network timestamp: `;
    expect(logged).toEqual([
      `${prefix}9000000000000000`,
      `${prefix}9000000000000000`,
      `${prefix}18446744073709551615`,
      `${prefix}18446744073709551615`,
    ]);
  });
});
