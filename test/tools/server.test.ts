import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/server.js';
import { TOOL_ANNOTATIONS } from '../../src/tools/_shared.js';
import { startTestServer, TEST_NODE_HOST, type TestServer, TRANSFER_HASH } from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ACCOUNT = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';

describe('server registration', () => {
  it('lists exactly the registered tools in registration order with read-only annotations', async () => {
    server = await startTestServer();
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual([
      'symbol_network_info',
      'symbol_node_status',
      'symbol_account_get',
      'symbol_voting_key_status',
      'symbol_transaction_get',
      'symbol_transaction_search',
      'symbol_mosaic_get',
      'symbol_namespace_get',
      'symbol_fee_estimate',
      'symbol_address_parse',
      'symbol_time_convert',
      'symbol_harvesting_status',
      'symbol_network_compare',
      'symbol_harvesting_income',
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^symbol_[a-z]+_[a-z_]+$/);
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.annotations).toMatchObject(TOOL_ANNOTATIONS);
      expect(tool.outputSchema).toBeDefined();
      const props = (tool.outputSchema as { properties?: Record<string, unknown> }).properties;
      expect(Object.keys(props ?? {})[0]).toBe('summary');
    }
  });

  it('is stable across repeated listings', async () => {
    server = await startTestServer();
    const first = (await server.client.listTools()).tools.map((t) => t.name);
    const second = (await server.client.listTools()).tools.map((t) => t.name);
    expect(second).toEqual(first);
  });
});

describe('every tool returns structuredContent that validates against its outputSchema', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['symbol_network_info', {}],
    ['symbol_node_status', {}],
    ['symbol_account_get', { account: ACCOUNT }],
    ['symbol_voting_key_status', { account: ACCOUNT }],
    ['symbol_transaction_get', { transactionHash: TRANSFER_HASH }],
    ['symbol_transaction_search', { address: ACCOUNT }],
    ['symbol_mosaic_get', { mosaic: 'symbol.xym' }],
    ['symbol_namespace_get', { namespace: 'symbol.xym' }],
    ['symbol_fee_estimate', {}],
    ['symbol_address_parse', { value: ACCOUNT }],
    ['symbol_time_convert', { height: 5_763_675 }],
    ['symbol_harvesting_status', { account: ACCOUNT }],
    ['symbol_network_compare', {}],
    ['symbol_harvesting_income', { account: ACCOUNT, fromHeight: 5_763_675, toHeight: 5_763_675 }],
  ];
  for (const [name, args] of calls) {
    it(name, async () => {
      server = await startTestServer();
      const result = await server.callTool(name, args);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toBeDefined();
      expect(JSON.parse(result.text)).toEqual(result.structuredContent);
      expect(Object.keys(result.structuredContent ?? {})[0]).toBe('summary');
      expect(typeof result.structuredContent?.summary).toBe('string');
      const def = TOOLS.find((t) => t.name === name);
      expect(def?.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });
  }
});

describe('outbound requests', () => {
  it('only ever hit the SYMBOL_NODE_URL host, even with reference nodes configured', async () => {
    server = await startTestServer({
      env: {
        SYMBOL_REFERENCE_NODES: 'https://reference-a.test:3001,https://reference-b.test:3001',
      },
    });
    await server.callTool('symbol_network_info');
    await server.callTool('symbol_node_status');
    await server.callTool('symbol_account_get', { account: ACCOUNT });
    await server.callTool('symbol_voting_key_status', { account: ACCOUNT });
    await server.callTool('symbol_transaction_get', { transactionHash: TRANSFER_HASH });
    await server.callTool('symbol_transaction_search', { address: ACCOUNT });
    await server.callTool('symbol_mosaic_get', { mosaic: '6BED913FA20223F8' });
    await server.callTool('symbol_namespace_get', { namespace: 'symbol' });
    await server.callTool('symbol_fee_estimate', { transactionSizeBytes: 176 });
    await server.callTool('symbol_address_parse', { value: ACCOUNT });
    await server.callTool('symbol_time_convert', { epoch: 4004 });
    await server.callTool('symbol_harvesting_status', { account: ACCOUNT });
    await server.callTool('symbol_harvesting_income', {
      account: ACCOUNT,
      fromHeight: 5_763_675,
      toHeight: 5_763_675,
    });
    expect(server.requests.length).toBeGreaterThan(5);
    const hosts = new Set(server.requests.map((u) => u.host));
    expect([...hosts]).toEqual([TEST_NODE_HOST]);
    expect(server.requests.every((u) => u.protocol === 'https:')).toBe(true);
  });

  it('fetch network properties only once per process', async () => {
    server = await startTestServer();
    await server.callTool('symbol_network_info');
    await server.callTool('symbol_network_info');
    await server.callTool('symbol_node_status');
    const propertyCalls = server.requests.filter((u) => u.pathname === '/network/properties');
    expect(propertyCalls).toHaveLength(1);
  });
});
