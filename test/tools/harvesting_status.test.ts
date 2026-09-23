import { afterEach, describe, expect, it } from 'vitest';
import {
  fixture,
  mainnetRoutes,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const LINKED = '54E48E0C3625F1AC6DE5A8B2CD495D1DA3140745FD28145C9BCDE4FDA16F992B';

describe('symbol_harvesting_status', () => {
  it('reports the unlocked harvesters and limits without an account', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvesting_status');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      network: 'mainnet',
      node: { host: TEST_NODE_HOST, unlockedCount: 15 },
      limits: {
        minHarvesterBalance: '10000.000000',
        rawMinHarvesterBalance: '10000000000',
        maxHarvesterBalance: '50000000.000000',
        harvestBeneficiaryPercentage: 25,
        harvestingMosaic: { id: '6BED913FA20223F8', alias: 'symbol.xym', divisibility: 6 },
      },
      account: null,
    });
    const node = result.structuredContent?.node as { unlockedPublicKeys: string[] };
    const keys = node.unlockedPublicKeys;
    expect(keys).toHaveLength(15);
    expect(keys[0]).toBe(LINKED);
    expect(result.structuredContent?.summary).toMatch(/15 delegated harvesters unlocked/);
    expect(result.structuredContent?.summary).toMatch(
      /a balance from 10000\.000000 to 50000000\.000000 symbol\.xym \(both inclusive\)/,
    );
    expect(result.structuredContent?.summary).not.toMatch(/capped/);
    expect(server.requests.some((u) => u.pathname === '/node/unlockedaccount')).toBe(true);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('confirms the fixture account is unlocked on this node and can harvest', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvesting_status', { account: ADDRESS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.account).toMatchObject({
      address: ADDRESS,
      linkedPublicKey: LINKED,
      delegatedHarvestingConfigured: true,
      unlockedOnThisNode: true,
      balance: '4321000.000000',
      importanceNonZero: true,
      balanceWithinLimits: true,
      canHarvestHere: true,
      warnings: [],
    });
    expect(result.structuredContent?.summary).toMatch(/is unlocked on this node/);
    expect(result.structuredContent?.summary).toMatch(/\(within the limits\)/);
    expect(result.structuredContent?.summary).toMatch(/can harvest on this node/);
  });

  // catapult's ImportanceView::canHarvest requires minHarvesterBalance <= balance <=
  // maxHarvesterBalance: above the maximum an account cannot harvest at all.
  it('reports that an account above maxHarvesterBalance cannot harvest', async () => {
    const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    account.account.mosaics = [{ id: '6BED913FA20223F8', amount: '50000000000001' }];
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account },
    });
    const result = await server.callTool('symbol_harvesting_status', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const report = result.structuredContent?.account as Record<string, unknown>;
    expect(report).toMatchObject({
      balance: '50000000.000001',
      delegatedHarvestingConfigured: true,
      unlockedOnThisNode: true,
      importanceNonZero: true,
      balanceWithinLimits: false,
      canHarvestHere: false,
      warnings: [
        'Balance 50000000.000001 symbol.xym exceeds maxHarvesterBalance 50000000.000000: an account above it cannot harvest, and nodes drop it from their unlocked list. Move the excess to another account.',
      ],
    });
    expect(result.structuredContent?.summary).toMatch(/\(above the maximum\)/);
    expect(result.structuredContent?.summary).toMatch(/cannot currently harvest/);
    expect(result.structuredContent?.summary).not.toMatch(/only that amount counts/);
  });

  it('counts both limits as within the range', async () => {
    for (const amount of ['10000000000', '50000000000000']) {
      const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
      account.account.mosaics = [{ id: '6BED913FA20223F8', amount }];
      server = await startTestServer({
        routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account },
      });
      const result = await server.callTool('symbol_harvesting_status', { account: ADDRESS });
      expect(result.structuredContent?.account).toMatchObject({
        balanceWithinLimits: true,
        canHarvestHere: true,
        warnings: [],
      });
      await server.close();
      server = undefined;
    }
  });

  it('warns when the account is not delegated, not unlocked, or under-funded', async () => {
    const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    account.account.supplementalPublicKeys = { linked: { publicKey: 'A'.repeat(64) } };
    account.account.mosaics = [{ id: '6BED913FA20223F8', amount: '5000000' }];
    account.account.importance = '0';
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account },
    });
    const result = await server.callTool('symbol_harvesting_status', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const report = result.structuredContent?.account as Record<string, unknown>;
    expect(report).toMatchObject({
      delegatedHarvestingConfigured: false,
      unlockedOnThisNode: false,
      balanceWithinLimits: false,
      importanceNonZero: false,
      canHarvestHere: false,
    });
    const warnings = report.warnings as string[];
    expect(warnings.some((w) => /No VRF key/.test(w))).toBe(true);
    expect(warnings.some((w) => /not unlocked on/.test(w))).toBe(true);
    expect(warnings.some((w) => /below minHarvesterBalance/.test(w))).toBe(true);
    expect(warnings.some((w) => /Importance is zero/.test(w))).toBe(true);
    expect(result.structuredContent?.summary).toMatch(/\(below the minimum\)/);
    expect(result.structuredContent?.summary).toMatch(/cannot currently harvest/);
  });

  it('rejects an invalid account with a hint', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_harvesting_status', { account: 'Bogus!' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a valid Symbol account identifier/);
  });
});
