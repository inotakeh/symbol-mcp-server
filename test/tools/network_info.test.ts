import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fixture,
  jsonResponse,
  mainnetRoutes,
  startTestServer,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

describe('symbol_network_info', () => {
  it('describes mainnet from the fixtures', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_network_info');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: {
        name: 'mainnet',
        identifier: 104,
        generationHashSeed: '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6',
      },
      chain: {
        height: 5_763_675,
        finalizedHeight: 5_763_656,
        finalizationEpoch: 4004,
        finalizationPoint: 38,
      },
      blockGenerationTargetTimeSeconds: 30,
      votingSetGrouping: 1440,
      epochAdjustment: { seconds: 1_615_853_185, utc: '2021-03-16T00:06:25.000Z' },
      currency: { mosaicId: '6BED913FA20223F8', alias: 'symbol.xym', divisibility: 6 },
      fees: {
        minFeeMultiplier: 100,
        averageFeeMultiplier: 108,
        medianFeeMultiplier: 100,
        highestFeeMultiplier: 1136,
      },
      node: { url: 'https://node.test:3001' },
    });
    expect(result.structuredContent?.summary).toMatch(/mainnet/);
    expect(result.structuredContent?.summary).toMatch(/5,763,675/);
  });

  it('returns a hinted error when the node is unreachable', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        'GET /chain/info': () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    const result = await server.callTool('symbol_network_info');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Could not connect to node node\.test:3001/);
    expect(result.text).toMatch(/SYMBOL_NODE_URL/);
    expect(result.text).not.toMatch(/at .*\.ts:\d+/); // no stack trace
  });

  it('distinguishes timeouts', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        'GET /network/fees/transaction': () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        },
      },
    });
    const result = await server.callTool('symbol_network_info');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not answer .* within 10000 ms/);
    expect(result.text).toMatch(/SYMBOL_REQUEST_TIMEOUT_MS/);
  });

  it('keeps internal error details out of the reply and logs them to stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const chain = fixture<{ height: string }>('mainnet/chain-info.json');
    // Passes the REST schema (digits only) but overflows parseHeight -> internal Error.
    chain.height = '99999999999999999999';
    server = await startTestServer({ routes: { ...mainnetRoutes(), 'GET /chain/info': chain } });
    const result = await server.callTool('symbol_network_info');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Unexpected internal error while running the tool/);
    expect(result.text).not.toMatch(/invalid height/);
    expect(result.text).not.toMatch(/99999999999999999999/);
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toMatch(/unexpected internal error: Error: invalid height/);
  });

  it('reports an unexpected response shape without leaking the body', async () => {
    server = await startTestServer({
      routes: {
        ...mainnetRoutes(),
        'GET /chain/info': () => jsonResponse({ totally: 'different', secret: 'DO-NOT-LEAK' }),
      },
    });
    const result = await server.callTool('symbol_network_info');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unexpected response shape for \/chain\/info/);
    expect(result.text).not.toMatch(/DO-NOT-LEAK/);
  });
});
