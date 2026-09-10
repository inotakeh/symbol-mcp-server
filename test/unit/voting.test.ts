import { describe, expect, it } from 'vitest';
import {
  buildVotingStatus,
  classifyVotingKey,
  type VotingStatusParams,
} from '../../src/domain/voting.js';

const NOW = new Date('2026-09-10T03:00:00.000Z');

const baseParams: VotingStatusParams = {
  keys: [
    { publicKey: 'A'.repeat(64), startEpoch: 3340, endEpoch: 3699 },
    { publicKey: 'B'.repeat(64), startEpoch: 3700, endEpoch: 4059 },
  ],
  currentEpoch: 4004,
  currentHeight: 5_763_675,
  votingSetGrouping: 1440,
  averageBlockTimeMs: 30_030,
  now: NOW,
  timeZone: 'Asia/Tokyo',
  maxVotingKeysPerAccount: 3,
  minVotingKeyLifetime: 112,
  maxVotingKeyLifetime: 360,
  balanceRaw: 4_321_000_000_000n,
  minVoterBalance: 3_000_000_000_000n,
  currencyDivisibility: 6,
  currencyAlias: 'symbol.xym',
};

describe('classifyVotingKey', () => {
  it('classifies by epoch range (inclusive)', () => {
    const key = { publicKey: 'K', startEpoch: 10, endEpoch: 20 };
    expect(classifyVotingKey(key, 9)).toBe('future');
    expect(classifyVotingKey(key, 10)).toBe('active');
    expect(classifyVotingKey(key, 20)).toBe('active');
    expect(classifyVotingKey(key, 21)).toBe('expired');
  });
});

describe('buildVotingStatus with the mainnet account fixture', () => {
  const report = buildVotingStatus(baseParams);

  it('reports one expired and one active key, sorted by start epoch', () => {
    expect(report.votingKeys.map((k) => k.status)).toEqual(['expired', 'active']);
    expect(report.votingKeys[0]?.expiryHeight).toBe(5_325_120);
    expect(report.votingKeys[0]?.remainingEpochs).toBeUndefined();
  });

  it('computes remaining epochs, blocks, days and expiry for the active key', () => {
    const active = report.votingKeys[1];
    expect(active?.expiryHeight).toBe(5_843_520);
    expect(active?.remainingEpochs).toBe(55);
    expect(active?.remainingBlocks).toBe(79_845);
    expect(active?.remainingDays).toBe(27.8);
    // 79,845 blocks * 30.03s = 2,397,745.35s after NOW
    const expected = new Date(NOW.getTime() + 79_845 * 30_030);
    expect(active?.expiresAt?.utc).toBe(expected.toISOString());
    expect(active?.expiresAt?.local).toMatch(/^2026-10-08T\d\d:\d\d:\d\d\+09:00$/);
    expect(active?.lifetimeEpochs).toBe(360);
  });

  it('recommends a renewal window 7 to 3 days before expiry', () => {
    const active = report.votingKeys[1];
    const expiry = new Date(active?.expiresAt?.utc ?? 0).getTime();
    expect(new Date(active?.recommendedRenewalWindow?.from.utc ?? 0).getTime()).toBe(
      expiry - 7 * 86_400_000,
    );
    expect(new Date(active?.recommendedRenewalWindow?.to.utc ?? 0).getTime()).toBe(
      expiry - 3 * 86_400_000,
    );
  });

  it('counts slots including expired keys', () => {
    expect(report.constraints).toMatchObject({
      maxVotingKeysPerAccount: 3,
      slotsUsed: 2,
      slotsFree: 1,
      expiredKeysOccupyingSlots: 1,
    });
  });

  it('checks voter eligibility against minVoterBalance', () => {
    expect(report.eligibility).toMatchObject({
      balance: '4321000.000000',
      minVoterBalance: '3000000.000000',
      eligible: true,
      margin: '1321000.000000',
      currency: 'symbol.xym',
    });
  });

  it('warns because the active key expires within 30 days without a successor', () => {
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/expires at epoch 4059/);
    // Both the local and the UTC form appear, matching the structured expiresAt.
    const active = report.votingKeys.find((k) => k.status === 'active');
    expect(report.warnings[0]).toContain(`${active?.expiresAt?.local} (${active?.expiresAt?.utc})`);
    expect(report.warnings[0]).toMatch(/\+09:00 \(2026-10-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\)/);
  });
});

describe('buildVotingStatus edge cases', () => {
  it('does not warn when a successor key is registered', () => {
    const report = buildVotingStatus({
      ...baseParams,
      keys: [...baseParams.keys, { publicKey: 'C'.repeat(64), startEpoch: 4060, endEpoch: 4419 }],
    });
    expect(report.votingKeys.map((k) => k.status)).toEqual(['expired', 'active', 'future']);
    expect(report.votingKeys[2]?.startsAt).toBeDefined();
    expect(report.warnings.filter((w) => /expires/.test(w))).toHaveLength(0);
    // 3 slots used -> slot warning
    expect(report.constraints.slotsFree).toBe(0);
    expect(report.warnings.some((w) => /slots are used/.test(w))).toBe(true);
  });

  it('warns when no key is active', () => {
    const report = buildVotingStatus({ ...baseParams, keys: baseParams.keys.slice(0, 1) });
    expect(report.warnings.some((w) => /No active voting key/.test(w))).toBe(true);
  });

  it('warns when the balance is below minVoterBalance', () => {
    const report = buildVotingStatus({ ...baseParams, balanceRaw: 1_000_000n });
    expect(report.eligibility.eligible).toBe(false);
    expect(report.eligibility.margin).toBe('-2999999.000000');
    expect(report.warnings.some((w) => /below minVoterBalance/.test(w))).toBe(true);
  });

  it('does not warn about expiry when it is far away', () => {
    const report = buildVotingStatus({
      ...baseParams,
      currentEpoch: 3800,
      currentHeight: 5_470_000,
    });
    expect(report.warnings).toHaveLength(0);
  });

  it('handles an account with no voting keys', () => {
    const report = buildVotingStatus({ ...baseParams, keys: [] });
    expect(report.votingKeys).toEqual([]);
    expect(report.constraints.slotsFree).toBe(3);
    expect(report.warnings).toEqual(['No active voting key is registered for this account.']);
  });
});
