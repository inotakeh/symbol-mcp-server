/**
 * Live-node integration tests. Opt-in only:
 *   SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://sym-test-01.opening-line.jp:3001 npm test
 *   SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<node-host>:3001 \
 *     SYMBOL_REFERENCE_NODES=https://<other-node>:3001 \
 *     SYMBOL_INTEGRATION_ACCOUNT=<address or public key with voting keys> npm test
 * SYMBOL_INTEGRATION_ACCOUNT selects the account the account-level tools are exercised with;
 * without it the node's own main account is used and the voting-key count test is skipped.
 * Never runs in CI (vitest.config.ts excludes this directory unless SYMBOL_INTEGRATION=1).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestClient } from '../../src/client/rest.js';
import { ChainInfoSchema } from '../../src/client/schemas.js';
import { loadConfig, resolveNetwork } from '../../src/config.js';
import { AppContext } from '../../src/context.js';
import { heightToEpoch } from '../../src/domain/epoch.js';
import { createServer, TOOLS } from '../../src/server.js';

const enabled = process.env.SYMBOL_INTEGRATION === '1';
const INTEGRATION_ACCOUNT = process.env.SYMBOL_INTEGRATION_ACCOUNT?.trim() || undefined;

type Structured = Record<string, unknown>;

describe.skipIf(!enabled)('live node', () => {
  let ctx: AppContext;
  let client: Client;
  let handler: ReturnType<typeof createMcpHandler>;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(
      result.isError,
      `${name} ${JSON.stringify(args)}: ${JSON.stringify(result.content)}`,
    ).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as Structured;
    expect(Object.keys(sc)[0]).toBe('summary');
    const def = TOOLS.find((t) => t.name === name);
    expect(def?.outputSchema.safeParse(sc).success, `${name} output matches its schema`).toBe(true);
    return sc;
  };

  beforeAll(async () => {
    const config = loadConfig(process.env);
    const rest = new RestClient({
      baseUrl: config.nodeUrl,
      timeoutMs: config.requestTimeoutMs,
      userAgent: 'symbol-mcp-server/integration',
    });
    const network = await resolveNetwork(rest, config);
    ctx = new AppContext(config, rest, network, '0.0.0-integration');
    handler = createMcpHandler(() => createServer(ctx));
    const transport = new StreamableHTTPClientTransport(new URL('http://mcp.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    client = new Client(
      { name: 'integration', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await handler?.close();
  });

  /** SYMBOL_INTEGRATION_ACCOUNT when set, otherwise the node's own main account. */
  async function nodeAccount(): Promise<string> {
    if (INTEGRATION_ACCOUNT) return INTEGRATION_ACCOUNT;
    const info = await call('symbol_node_status');
    return (info.node as { publicKey: string }).publicKey;
  }

  it('epoch formula matches /chain/info', async () => {
    const chain = await ctx.rest.get('/chain/info', ChainInfoSchema);
    const { properties } = await ctx.getNetworkData();
    expect(
      heightToEpoch(Number(chain.latestFinalizedBlock.height), properties.votingSetGrouping),
    ).toBe(chain.latestFinalizedBlock.finalizationEpoch);
  });

  it('symbol_network_info and symbol_node_status answer without error', async () => {
    await call('symbol_network_info');
    await call('symbol_node_status');
  });

  it('symbol_account_get and symbol_voting_key_status answer for a real account', async () => {
    const account = await nodeAccount();
    await call('symbol_account_get', { account });
    await call('symbol_voting_key_status', { account });
  });

  it.skipIf(!INTEGRATION_ACCOUNT)(
    'symbol_voting_key_status lists the voting keys of SYMBOL_INTEGRATION_ACCOUNT',
    async () => {
      const voting = await call('symbol_voting_key_status', { account: INTEGRATION_ACCOUNT });
      expect((voting.votingKeys as unknown[]).length).toBeGreaterThanOrEqual(1);
    },
  );

  it('symbol_transaction_search then symbol_transaction_get round-trip a confirmed transaction', async () => {
    const account = await nodeAccount();
    const page = await call('symbol_transaction_search', { address: account, pageSize: 10 });
    const rows = page.transactions as Array<{ hash: string; type: { name: string } }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const first = rows[0];
    expect(first?.hash).toMatch(/^[0-9A-F]{64}$/);
    const tx = await call('symbol_transaction_get', { transactionHash: first?.hash ?? '' });
    expect(tx.status).toBe('confirmed');
    expect((tx.transaction as { type: { name: string } }).type.name).toBe(first?.type.name);
    const missing = await call('symbol_transaction_get', { transactionHash: '0'.repeat(64) });
    expect(missing.status).toBe('not_found');
  });

  it('symbol_transaction_search honours a type filter', async () => {
    const account = await nodeAccount();
    const page = await call('symbol_transaction_search', { address: account, type: 'transfer' });
    for (const row of page.transactions as Array<{ type: { code: number } }>) {
      expect(row.type.code).toBe(16724);
    }
  });

  it('symbol_namespace_get and symbol_mosaic_get resolve the currency alias', async () => {
    const { currency } = await ctx.getNetworkData();
    if (!currency.alias) return; // network without a currency alias: nothing to resolve
    const ns = await call('symbol_namespace_get', { namespace: currency.alias });
    expect((ns.alias as { type: string; mosaicId: string }).mosaicId).toBe(currency.mosaicId);
    const byName = await call('symbol_mosaic_get', { mosaic: currency.alias });
    expect(byName.id).toBe(currency.mosaicId);
    const byId = await call('symbol_mosaic_get', { mosaic: currency.mosaicId });
    expect(byId.divisibility).toBe(currency.divisibility);
  });

  it('symbol_fee_estimate and symbol_address_parse answer', async () => {
    const fee = await call('symbol_fee_estimate');
    expect((fee.tiers as { slow: { multiplier: number } }).slow.multiplier).toBeGreaterThanOrEqual(
      0,
    );
    const parsed = await call('symbol_address_parse', { value: await nodeAccount() });
    expect(parsed.valid).toBe(true);
    expect((parsed.network as { matchesConfiguredNetwork: boolean }).matchesConfiguredNetwork).toBe(
      true,
    );
  });

  it('symbol_time_convert agrees with /chain/info for the finalized height', async () => {
    const chain = await ctx.rest.get('/chain/info', ChainInfoSchema);
    const height = Number(chain.latestFinalizedBlock.height);
    const byHeight = await call('symbol_time_convert', { height });
    expect(byHeight.epoch).toBe(chain.latestFinalizedBlock.finalizationEpoch);
    expect(byHeight.isEstimate).toBe(false);
    const byEpoch = await call('symbol_time_convert', {
      epoch: chain.latestFinalizedBlock.finalizationEpoch,
    });
    const range = byEpoch.epochRange as { startHeight: number; endHeight: number };
    expect(height).toBeGreaterThanOrEqual(range.startHeight);
    expect(height).toBeLessThanOrEqual(range.endHeight);
    const future = await call('symbol_time_convert', { height: Number(chain.height) + 100_000 });
    expect(future.isEstimate).toBe(true);
  });

  it('symbol_harvesting_status answers, with and without an account', async () => {
    const plain = await call('symbol_harvesting_status');
    expect(typeof (plain.node as { unlockedCount: number }).unlockedCount).toBe('number');
    const withAccount = await call('symbol_harvesting_status', { account: await nodeAccount() });
    expect(withAccount.account).not.toBeNull();
  });

  it.skipIf(!INTEGRATION_ACCOUNT)(
    'symbol_harvesting_income totals the last three days for SYMBOL_INTEGRATION_ACCOUNT',
    async () => {
      const today = new Date();
      const isoDay = (d: Date) => d.toISOString().slice(0, 10);
      const income = await call('symbol_harvesting_income', {
        account: INTEGRATION_ACCOUNT,
        fromDate: isoDay(new Date(today.getTime() - 2 * 86_400_000)),
        toDate: isoDay(today),
      });
      expect((income.totals as { receipts: number }).receipts).toBeGreaterThanOrEqual(1);
      const days = (income.daily as unknown[]).length;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(4);
    },
  );

  it('symbol_network_compare answers (reference nodes optional)', async () => {
    const result = await call('symbol_network_compare');
    const nodes = result.nodes as Array<{ role: string; reachable: boolean }>;
    expect(nodes[0]?.role).toBe('own');
    expect(nodes[0]?.reachable).toBe(true);
    expect(result.referenceNodesConfigured).toBe(ctx.config.referenceNodes.length > 0);
  });
});
