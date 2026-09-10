import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_NODE_HOST, type TestServer } from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('symbol_fee_estimate', () => {
  it('uses the representative transfer size by default', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_fee_estimate');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      currency: 'symbol.xym',
      sizeBytes: 197,
      tiers: {
        slow: { multiplier: 100, rawFee: '19700', fee: '0.019700' },
        average: { multiplier: 108, rawFee: '21276', fee: '0.021276' },
        median: { multiplier: 100, rawFee: '19700', fee: '0.019700' },
        fast: { multiplier: 1136, rawFee: '223792', fee: '0.223792' },
      },
      multipliers: { minFeeMultiplier: 100, highestFeeMultiplier: 1136, lowestFeeMultiplier: 0 },
    });
    expect(result.structuredContent?.sizeAssumption).toMatch(/197 bytes/);
    expect(result.structuredContent?.summary).toMatch(/197-byte transaction/);
    expect(result.structuredContent?.summary).toMatch(/Nothing was sent/);
    expect(server.requests.some((u) => u.pathname === '/network/fees/transaction')).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('accepts an explicit size and matches the captured transfer fee', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_fee_estimate', { transactionSizeBytes: 176 });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.sizeBytes).toBe(176);
    const tiers = result.structuredContent?.tiers as { fast: { fee: string } };
    expect(tiers.fast.fee).toBe('0.199936');
    expect(result.structuredContent?.sizeAssumption).toMatch(/supplied by the caller/);
  });

  it('rejects sizes outside the allowed range', async () => {
    server = await startTestServer();
    for (const bad of [0, -5, 2_000_000, 12.5]) {
      const result = await server.callTool('symbol_fee_estimate', { transactionSizeBytes: bad });
      expect(result.isError).toBe(true);
    }
  });
});
