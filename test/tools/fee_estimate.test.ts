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
    expect(result.structuredContent?.sizeAssumption).toBe(
      'Representative transfer: 128-byte header + 32-byte transfer body + 1 mosaic (16 bytes) + a 20-character ASCII message (1 type byte + 20 UTF-8 bytes = 21 bytes) = 197 bytes. A plain message counts in UTF-8 bytes, not characters (usually 3 per Japanese character).',
    );
    expect(result.structuredContent?.summary).toMatch(/197-byte transaction/);
    expect(result.structuredContent?.summary).toMatch(
      /20-character ASCII message\. A plain message counts in UTF-8 bytes plus 1 type byte \(a 20-character Japanese message makes 237 bytes\)/,
    );
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
    expect(result.structuredContent?.sizeAssumption).toBe(
      'Size supplied by the caller: 176 bytes, used as given.',
    );
    expect(result.structuredContent?.summary).toMatch(
      /\nSize as supplied by the caller, used as given\. Nothing was sent\.$/,
    );
  });

  it('tells the model to count a message in UTF-8 bytes plus its type byte, not for aggregates', async () => {
    server = await startTestServer();
    const { tools } = await server.client.listTools();
    const size = tools.find((t) => t.name === 'symbol_fee_estimate')?.inputSchema.properties
      ?.transactionSizeBytes as { description?: string } | undefined;
    expect(size?.description).toBe(
      'Serialized transaction size in bytes. Omit to use a representative transfer: 1 mosaic and a 20-character ASCII message = 197 bytes. For a transfer, count 160 bytes, plus 16 per mosaic, plus a plain message: 1 type byte and its text in UTF-8 bytes, not characters (1 per ASCII character, usually 3 per Japanese character). No message and 1 mosaic = 176 bytes; a 20-character Japanese message and 1 mosaic = 237 bytes. An encrypted message or a harvesting delegation request carries more than its text, so pass its serialized size. This count is not for aggregate transactions, whose size also includes their inner transactions and cosignatures.',
    );
  });

  it('rejects sizes outside the allowed range', async () => {
    server = await startTestServer();
    for (const bad of [0, -5, 2_000_000, 12.5]) {
      const result = await server.callTool('symbol_fee_estimate', { transactionSizeBytes: bad });
      expect(result.isError).toBe(true);
    }
  });
});
