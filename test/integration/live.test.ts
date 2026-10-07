/**
 * Live-node integration tests. Opt-in only:
 *   SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<testnet-node>:3001 npm test
 *   SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<node-host>:3001 \
 *     SYMBOL_REFERENCE_NODES=https://<other-node>:3001 \
 *     SYMBOL_INTEGRATION_ACCOUNT=<address or public key of a harvesting voting account> npm test
 * Pick the nodes on https://nodewatch.symbol.tools/ (README, "Choosing a node"): API nodes of the
 * network at the current height that answer on https:// (usually port 3001).
 * SYMBOL_INTEGRATION_ACCOUNT selects the account the account-level tools are exercised with;
 * without it the node's own main account is used and the tests that need that account (voting-key
 * count, finality participation, harvesting income of the last three days) are skipped.
 * SYMBOL_INTEGRATION_MULTISIG_ACCOUNT=<address of a multisig account> checks that
 * symbol_account_get reports it as a multisig account and its first cosignatory as a cosignatory;
 * without it that test is skipped.
 * Every registered tool is called (the last test checks it; run the whole file for it to pass).
 * Inputs come from the environment or from the node itself (the node's account, a hash found by
 * a search), never from literals; tools that read many pages get small arguments.
 * symbol_harvesting_status runs in its modes "current" and "compare", so no snapshot is written.
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
const MULTISIG_ACCOUNT = process.env.SYMBOL_INTEGRATION_MULTISIG_ACCOUNT?.trim() || undefined;

type Structured = Record<string, unknown>;
/**
 * What a tool argument can be. Narrower than unknown on purpose: an internal value (such as the
 * cleaned-text object of ctx.getNetworkData(), passed by mistake before #61) fails typecheck.
 */
type ToolArgument = string | number | boolean | readonly string[];

/** Tools that only the tests needing SYMBOL_INTEGRATION_ACCOUNT call. */
const ONLY_WITH_INTEGRATION_ACCOUNT: ReadonlySet<string> = new Set([
  'symbol_finality_participation',
  'symbol_harvesting_income',
]);

/** An optional environment value inside a test that is skipped unless it is set. */
function required(value: string | undefined): string {
  if (value === undefined) throw new Error('test ran without the environment value it needs');
  return value;
}
interface MultisigOutput {
  minApproval: number;
  cosignatoryAddresses: string[];
  multisigAddresses: string[];
}

describe.skipIf(!enabled)('live node', () => {
  let ctx: AppContext;
  let client: Client;
  let handler: ReturnType<typeof createMcpHandler>;
  /** Every tool name passed to call(), for the coverage check at the end. */
  const called = new Set<string>();

  const call = async (name: string, args: Record<string, ToolArgument> = {}) => {
    called.add(name);
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

  /** What symbol_node_status read from /node/info; the tool gives null when that request failed. */
  async function nodeIdentity(): Promise<{ publicKey: string; version: string }> {
    const status = await call('symbol_node_status');
    const node = status.node as { publicKey: string; version: string } | null;
    if (node === null) throw new Error('the node did not answer /node/info');
    return node;
  }

  /** SYMBOL_INTEGRATION_ACCOUNT when set, otherwise the node's own main account. */
  async function nodeAccount(): Promise<string> {
    if (INTEGRATION_ACCOUNT) return INTEGRATION_ACCOUNT;
    return (await nodeIdentity()).publicKey;
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
      const voting = await call('symbol_voting_key_status', {
        account: required(INTEGRATION_ACCOUNT),
      });
      expect((voting.votingKeys as unknown[]).length).toBeGreaterThanOrEqual(1);
    },
  );

  it.skipIf(!MULTISIG_ACCOUNT)(
    'symbol_account_get reports SYMBOL_INTEGRATION_MULTISIG_ACCOUNT as a multisig account and its first cosignatory as a cosignatory',
    async () => {
      const result = await call('symbol_account_get', { account: required(MULTISIG_ACCOUNT) });
      const multisig = result.multisig as MultisigOutput | null;
      expect(multisig, 'multisig entry of SYMBOL_INTEGRATION_MULTISIG_ACCOUNT').not.toBeNull();
      expect(multisig?.minApproval).toBeGreaterThanOrEqual(1);
      expect(multisig?.cosignatoryAddresses.length).toBeGreaterThanOrEqual(1);
      expect(result.summary).toMatch(/; multisig \d+-of-\d+/);

      const self = (result.address as { base32: string }).base32;
      const cosignatory = multisig?.cosignatoryAddresses[0] ?? '';
      const cosigner = await call('symbol_account_get', { account: cosignatory });
      expect((cosigner.multisig as MultisigOutput | null)?.multisigAddresses).toContain(self);
      expect(cosigner.summary).toMatch(/cosignatory of \d+ multisig account/);
    },
  );

  it.skipIf(!INTEGRATION_ACCOUNT)(
    'symbol_finality_participation judges the latest finalized epoch for SYMBOL_INTEGRATION_ACCOUNT',
    async () => {
      const result = await call('symbol_finality_participation', {
        account: required(INTEGRATION_ACCOUNT),
      });
      const epochs = result.epochs as Array<{ epoch: number; status: string }>;
      expect(epochs).toHaveLength(1);
      expect(epochs[0]?.epoch).toBe(
        (result.current as { finalizationEpoch: number }).finalizationEpoch,
      );
      expect(['participated', 'missed']).toContain(epochs[0]?.status);
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
    // Take the alias from a tool's output, as a client would. The value in ctx.getNetworkData()
    // is the internal cleaned-text object ({ text, removed, key }), not a string.
    const info = await call('symbol_network_info');
    const currency = info.currency as {
      mosaicId: string;
      alias: string | null;
      divisibility: number;
    };
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

  it('symbol_harvesting_status counts the unlocked harvesters and compares without saving', async () => {
    // The default mode: the count and the limits, and no snapshot file is looked at.
    const now = await call('symbol_harvesting_status');
    expect(now.mode).toBe('current');
    const count = (now.current as { count: number; keys: string[] | null }).count;
    expect(count).toBeGreaterThanOrEqual(0);
    expect((now.current as { keys: string[] | null }).keys).toBeNull();
    expect(now).toMatchObject({ comparison: null, history: null, saved: false, stateFile: null });
    expect(typeof (now.limits as { minHarvesterBalance: string }).minHarvesterBalance).toBe(
      'string',
    );
    // detailed lists the keys the count counts.
    const listed = await call('symbol_harvesting_status', { format: 'detailed' });
    const keys = (listed.current as { keys: string[] | null }).keys;
    expect(keys).toHaveLength((listed.current as { count: number }).count);
    // compare reads the snapshot file when SYMBOL_STATE_DIR is set, and never writes.
    const compared = await call('symbol_harvesting_status', { mode: 'compare' });
    expect(compared.saved).toBe(false);
    if (!ctx.config.stateDir) expect(compared.comparison).toBeNull();
  });

  it.skipIf(!INTEGRATION_ACCOUNT)(
    'symbol_harvesting_income totals the last three days for SYMBOL_INTEGRATION_ACCOUNT',
    async () => {
      const today = new Date();
      const isoDay = (d: Date) => d.toISOString().slice(0, 10);
      const income = await call('symbol_harvesting_income', {
        account: required(INTEGRATION_ACCOUNT),
        fromDate: isoDay(new Date(today.getTime() - 2 * 86_400_000)),
        toDate: isoDay(today),
      });
      expect((income.totals as { receipts: number }).receipts).toBeGreaterThanOrEqual(1);
      const days = (income.daily as unknown[]).length;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(4);
    },
  );

  it('symbol_transaction_status reports a confirmed transaction found by a search, and an unknown hash', async () => {
    const account = await nodeAccount();
    const page = await call('symbol_transaction_search', { address: account, pageSize: 10 });
    const rows = page.transactions as Array<{ hash: string; height: number | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const first = rows[0];
    const unknown = '0'.repeat(64);
    const result = await call('symbol_transaction_status', {
      transactionHashes: [first?.hash ?? '', unknown],
    });
    const statuses = result.statuses as Array<{
      hash: string;
      group: string;
      height: number | null;
    }>;
    expect(statuses.map((s) => s.hash)).toEqual([first?.hash, unknown]);
    expect(statuses[0]).toMatchObject({ group: 'confirmed', height: first?.height });
    expect(statuses[1]?.group).toBe('not_found');
  });

  it('symbol_node_status gives a verdict from its seven checks, and a sync judgment that follows the chain tip check', async () => {
    const status = await call('symbol_node_status', { format: 'detailed' });
    expect(['healthy', 'degraded', 'unhealthy']).toContain(status.verdict);
    const checks = status.checks as Array<{ id: string; status: string; hint: string | null }>;
    expect(checks.map((c) => c.id)).toEqual([
      'api_node',
      'db',
      'storage_consistent',
      'clock_skew',
      'finalization_lag',
      'roles',
      'chain_tip_age',
    ]);
    // detailed: every check that was made carries a hint.
    expect(checks.every((c) => typeof c.hint === 'string')).toBe(true);
    // synced is the chain tip check read as yes / no / not judged.
    const tip = checks[6]?.status;
    const sync = status.sync as { synced: boolean | null; thresholdSeconds: number };
    expect(sync.synced).toBe(tip === 'unknown' ? null : tip === 'ok');
    expect(sync.thresholdSeconds).toBeGreaterThan(0);
    expect(String(status.summary).startsWith(`${ctx.rest.host} `)).toBe(true);
  });

  it('symbol_version_drift compares the node version with a sample that adds up', async () => {
    const drift = await call('symbol_version_drift');
    expect(['ok', 'behind', 'far_behind', 'unknown']).toContain(drift.verdict);
    expect((drift.node as { version: string }).version).toBe((await nodeIdentity()).version);
    const sample = drift.sample as { size: number };
    const distribution = drift.distribution as Array<{ count: number }>;
    expect(distribution.reduce((sum, d) => sum + d.count, 0)).toBe(sample.size);
  });

  it('symbol_delegation_diagnose runs its eleven checks for a real account (one day of blocks)', async () => {
    const result = await call('symbol_delegation_diagnose', {
      account: await nodeAccount(),
      recentDays: 1,
    });
    expect(['active', 'not_active', 'cannot_verify']).toContain(result.verdict);
    expect((result.checks as Array<{ id: string }>).map((c) => c.id)).toEqual([
      'account_exists',
      'balance_in_range',
      'importance_positive',
      'linked_key',
      'vrf_key',
      'node_key',
      'node_key_matches_configured_node',
      'unlocked_on_node',
      'account_type',
      'recent_harvest',
      'delegation_request_found',
    ]);
  });

  it('symbol_account_rank lists the top holders in order and ranks a real account (one page each)', async () => {
    const top = await call('symbol_account_rank', { top: 3 });
    const holders = top.topHolders as Array<{ rank: number; balanceRaw: string }>;
    expect(holders.length).toBeLessThanOrEqual(3);
    expect(holders.map((h) => h.rank)).toEqual(holders.map((_, i) => i + 1));
    for (let i = 1; i < holders.length; i++) {
      expect(
        BigInt(holders[i - 1]?.balanceRaw ?? '0') >= BigInt(holders[i]?.balanceRaw ?? '0'),
      ).toBe(true);
    }
    const ranked = await call('symbol_account_rank', {
      account: await nodeAccount(),
      top: 1,
      maxRank: 100,
    });
    const target = ranked.account as { rank: number | null; rankBeyond: number | null };
    if (target.rank !== null) expect(target.rank).toBeLessThanOrEqual(100);
    else expect([100, null]).toContain(target.rankBeyond);
  });

  it('symbol_holdings_value at a unit price of 1 equals the balance', async () => {
    const result = await call('symbol_holdings_value', {
      account: await nodeAccount(),
      unitPrice: '1',
      currency: 'JPY',
    });
    expect((result.value as { exact: string }).exact).toBe(
      (result.balance as { amount: string }).amount,
    );
  });

  it('symbol_network_compare answers (reference nodes optional)', async () => {
    const result = await call('symbol_network_compare');
    const nodes = result.nodes as Array<{ role: string; reachable: boolean }>;
    expect(nodes[0]?.role).toBe('own');
    expect(nodes[0]?.reachable).toBe(true);
    expect(result.referenceNodesConfigured).toBe(ctx.config.referenceNodes.length > 0);
  });

  // Last in the file: every registered tool was called above (the two that need
  // SYMBOL_INTEGRATION_ACCOUNT only when it is set).
  it('called every registered tool', () => {
    const expected = TOOLS.map((t) => t.name).filter(
      (name) => INTEGRATION_ACCOUNT || !ONLY_WITH_INTEGRATION_ACCOUNT.has(name),
    );
    expect([...called].sort()).toEqual([...expected].sort());
  });
});
