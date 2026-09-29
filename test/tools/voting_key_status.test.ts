import { afterEach, describe, expect, it } from 'vitest';
import {
  fixture,
  H,
  mainnetRoutes,
  resourceNotFound,
  startTestServer,
  TEST_NOW,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';

describe('symbol_voting_key_status', () => {
  it('computes the fixture account voting key status', async () => {
    server = await startTestServer({ env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' } });
    const result = await server.callTool('symbol_voting_key_status', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;

    expect(sc.current).toMatchObject({
      height: 5_763_675,
      finalizedHeight: 5_763_656,
      finalizationEpoch: 4004,
      votingSetGrouping: 1440,
      averageBlockTimeSeconds: 30.03,
      averageBlockTimeSampleBlocks: 10_000,
      checkedAt: { utc: TEST_NOW.toISOString(), local: '2026-09-10T12:05:00+09:00' },
    });
    expect((sc.current as { estimateNote: string }).estimateNote).toMatch(/estimates/);

    const keys = sc.votingKeys as Array<Record<string, unknown>>;
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({
      publicKey: 'C38F80FBE1388C1C9BF7E5EF4664DA3AF45D750D65230FBFCC42CEC6481E68FE',
      startEpoch: 3340,
      endEpoch: 3699,
      status: 'expired',
      expiryHeight: 5_325_120,
    });
    const active = keys[1] as Record<string, unknown>;
    expect(active).toMatchObject({
      publicKey: '534A99C9338ECD32AD8E8C3F38304D2A9477049601ECE134A11F36EB4D36D549',
      startEpoch: 3700,
      endEpoch: 4059,
      status: 'active',
      expiryHeight: 5_843_520,
      remainingEpochs: 55,
      remainingBlocks: 79_845,
      remainingDays: 27.8,
    });
    const expiresAt = active.expiresAt as { utc: string; local: string };
    expect(expiresAt.utc).toBe(new Date(TEST_NOW.getTime() + 79_845 * 30_030).toISOString());
    expect(expiresAt.local).toMatch(/^2026-10-08T/);
    const window = active.recommendedRenewalWindow as {
      from: { utc: string; local: string };
      to: { utc: string; local: string };
    };
    expect(new Date(window.from.utc).getTime()).toBe(
      new Date(expiresAt.utc).getTime() - 7 * 86_400_000,
    );
    expect(new Date(window.to.utc).getTime()).toBe(
      new Date(expiresAt.utc).getTime() - 3 * 86_400_000,
    );

    expect(sc.constraints).toMatchObject({
      maxVotingKeysPerAccount: 3,
      minVotingKeyLifetime: 112,
      maxVotingKeyLifetime: 360,
      slotsUsed: 2,
      slotsFree: 1,
      expiredKeysOccupyingSlots: 1,
    });
    expect(sc.eligibility).toMatchObject({
      balance: '4321000.000000',
      minVoterBalance: '3000000.000000',
      eligible: true,
      currency: 'symbol.xym',
    });
    expect(sc.warnings).toEqual([
      expect.stringMatching(/expires at epoch 4059 in about 27\.8 days/),
    ]);
    // Warnings and summary use the same "local (utc)" notation as checkedAt.
    const warning = (sc.warnings as string[])[0] ?? '';
    expect(warning).toContain(`${expiresAt.local} (${expiresAt.utc})`);
    expect(sc.summary).toMatch(/2 voting keys registered \(1 active, 0 future, 1 expired\)/);
    expect(sc.summary).toMatch(/epochs 3700-4059/);
    expect(sc.summary).toContain(`estimated ${expiresAt.local} (${expiresAt.utc})`);
    expect(sc.summary).toContain(`${window.from.local} (${window.from.utc}) to`);
    expect(sc.summary).toMatch(/Recommended renewal window/);
  });

  it('uses the block endpoints for the measured average block time', async () => {
    server = await startTestServer();
    await server.callTool('symbol_voting_key_status', { account: ADDRESS });
    const paths = server.requests.map((u) => u.pathname);
    expect(paths).toContain('/blocks/5763675');
    expect(paths).toContain('/blocks/5753675');
    expect(paths).toContain('/chain/info');
    expect(paths).toContain(`/accounts/${ADDRESS}`);
  });

  it('reports an account without voting keys and an insufficient balance', async () => {
    const account = fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
    account.account.supplementalPublicKeys = {};
    account.account.mosaics = [{ id: '6BED913FA20223F8', amount: '1000000' }];
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account },
    });
    const result = await server.callTool('symbol_voting_key_status', { account: ADDRESS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.votingKeys).toEqual([]);
    expect(result.structuredContent?.eligibility).toMatchObject({
      eligible: false,
      balance: '1.000000',
    });
    expect(result.structuredContent?.warnings).toEqual([
      'No active voting key is registered for this account.',
      expect.stringMatching(/below minVoterBalance/),
    ]);
  });

  // Three keys and no expired one: the fixture's active key 3700-4059 and two future keys.
  function accountWithKeys(successorStart: number) {
    const account = fixture<{
      account: { supplementalPublicKeys: { voting: { publicKeys: unknown[] } } };
    }>('mainnet/account-voting.json');
    account.account.supplementalPublicKeys.voting.publicKeys = [
      { publicKey: H('fixture:voting-key-2'), startEpoch: 3700, endEpoch: 4059 },
      { publicKey: H('fixture:voting-key-3'), startEpoch: successorStart, endEpoch: 4419 },
      { publicKey: H('fixture:voting-key-4'), startEpoch: 4420, endEpoch: 4779 },
    ];
    return { ...mainnetRoutes(), [`GET /accounts/${ADDRESS}`]: account };
  }

  it('does not warn about full slots when no key has expired and the successor has no gap', async () => {
    server = await startTestServer({ routes: accountWithKeys(4060) });
    const result = await server.callTool('symbol_voting_key_status', { account: ADDRESS });
    expect(result.structuredContent?.constraints).toMatchObject({
      slotsFree: 0,
      expiredKeysOccupyingSlots: 0,
    });
    expect(result.structuredContent?.warnings).toEqual([]);
    expect(result.structuredContent?.summary).not.toMatch(/Warnings:/);
  });

  it('warns about full slots without advice to unlink when the successor leaves a gap', async () => {
    server = await startTestServer({ routes: accountWithKeys(4100) });
    const result = await server.callTool('symbol_voting_key_status', { account: ADDRESS });
    const warnings = result.structuredContent?.warnings as string[];
    expect(warnings).toContain(
      'All 3 voting key slots are taken by keys that have not expired, so there is no slot for a new key yet.',
    );
    expect(warnings.some((w) => /[Uu]nlink/.test(w))).toBe(false);
    expect(result.structuredContent?.summary).not.toMatch(/[Uu]nlink/);
  });

  it('returns a hinted error for unknown accounts', async () => {
    const unknown = 'TATNE7Q5BITMUTRRN6IB4I7FLSDRDWZA37JGO5Q';
    server = await startTestServer({
      routes: { ...mainnetRoutes(), [`GET /accounts/${unknown}`]: resourceNotFound(unknown) },
    });
    const result = await server.callTool('symbol_voting_key_status', { account: unknown });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /No account with address TATNE7Q5BITMUTRRN6IB4I7FLSDRDWZA37JGO5Q exists on mainnet/,
    );
    expect(result.text).toMatch(/mainnet or testnet/);
  });
});
