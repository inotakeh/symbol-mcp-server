import { afterEach, describe, expect, it } from 'vitest';
import { fixture, mainnetRoutes, startTestServer, TEST_NOW, type TestServer } from './harness.js';

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
