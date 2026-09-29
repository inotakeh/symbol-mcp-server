import { describe, expect, it } from 'vitest';
import { mapVotingKeys } from '../../src/cli/check.js';
import { heightToEpoch, votingKeyExpiryHeight } from '../../src/domain/epoch.js';
import {
  BELOW_MIN_VOTER_BALANCE,
  buildVotingStatus,
  classifyVotingKey,
  EXPIRY_WARNING_DAYS,
  hasSuccessorKey,
  longestActiveKey,
  RENEWAL_WINDOW_END_DAYS,
  SLOTS_FULL,
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

describe('hasSuccessorKey', () => {
  const key = { endEpoch: 4059 };
  it('is true when a future key starts no later than the epoch after the key ends', () => {
    expect(hasSuccessorKey(key, [{ startEpoch: 4060 }])).toBe(true);
    expect(hasSuccessorKey(key, [{ startEpoch: 4050 }])).toBe(true);
    expect(hasSuccessorKey(key, [{ startEpoch: 4200 }, { startEpoch: 4060 }])).toBe(true);
  });
  it('is false with a gap of one epoch or more, and without future keys', () => {
    expect(hasSuccessorKey(key, [{ startEpoch: 4061 }])).toBe(false);
    expect(hasSuccessorKey(key, [])).toBe(false);
  });
  it('shares the end of the renewal window with the CLI check (3 days)', () => {
    expect(RENEWAL_WINDOW_END_DAYS).toBe(3);
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

  it('warns because the active key expires within 45 days without a successor', () => {
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

describe('the slot warning when every slot is used', () => {
  const ACTIVE = { publicKey: 'B'.repeat(64), startEpoch: 3700, endEpoch: 4059 };
  const EXPIRED = { publicKey: 'A'.repeat(64), startEpoch: 3340, endEpoch: 3699 };
  const slotWarnings = (warnings: readonly string[]) => warnings.filter((w) => /slot/.test(w));

  it('keeps the advice to unlink when an expired key holds a slot', () => {
    const report = buildVotingStatus({
      ...baseParams,
      keys: [EXPIRED, ACTIVE, { publicKey: 'C'.repeat(64), startEpoch: 4060, endEpoch: 4419 }],
    });
    expect(slotWarnings(report.warnings)).toEqual([
      'All 3 voting key slots are used (1 expired). Unlink an expired key before registering a new one.',
    ]);
  });

  it('is silent when no key has expired and a successor takes over without a gap', () => {
    const report = buildVotingStatus({
      ...baseParams,
      keys: [
        ACTIVE,
        { publicKey: 'C'.repeat(64), startEpoch: 4060, endEpoch: 4419 },
        { publicKey: 'D'.repeat(64), startEpoch: 4420, endEpoch: 4779 },
      ],
    });
    expect(report.constraints).toMatchObject({ slotsFree: 0, expiredKeysOccupyingSlots: 0 });
    expect(report.warnings).toEqual([]);
    expect(report.summaryWarnings).toEqual([]);
  });

  it('warns without advice to unlink when no key has expired and the successor leaves a gap', () => {
    const report = buildVotingStatus({
      ...baseParams,
      keys: [
        ACTIVE,
        { publicKey: 'C'.repeat(64), startEpoch: 4100, endEpoch: 4459 },
        { publicKey: 'D'.repeat(64), startEpoch: 4460, endEpoch: 4819 },
      ],
    });
    expect(slotWarnings(report.warnings)).toEqual([
      'All 3 voting key slots are taken by keys that have not expired, so there is no slot for a new key yet.',
    ]);
    expect(report.warnings.some((w) => /[Uu]nlink|expired key/.test(w))).toBe(false);
  });

  it('warns without advice to unlink when no key is active and none has expired', () => {
    const report = buildVotingStatus({
      ...baseParams,
      keys: [
        { publicKey: 'C'.repeat(64), startEpoch: 4100, endEpoch: 4459 },
        { publicKey: 'D'.repeat(64), startEpoch: 4460, endEpoch: 4819 },
        { publicKey: 'E'.repeat(64), startEpoch: 4820, endEpoch: 5179 },
      ],
    });
    expect(slotWarnings(report.warnings)).toHaveLength(1);
    expect(report.warnings.some((w) => /[Uu]nlink|expired key/.test(w))).toBe(false);
  });

  it('agrees with the CLI check on when the renewal is done', () => {
    for (const successorStart of [4060, 4100]) {
      const report = buildVotingStatus({
        ...baseParams,
        keys: [
          ACTIVE,
          { publicKey: 'C'.repeat(64), startEpoch: successorStart, endEpoch: successorStart + 359 },
          { publicKey: 'D'.repeat(64), startEpoch: 4500, endEpoch: 4859 },
        ],
      });
      const cli = mapVotingKeys(report, 14);
      const renewed = cli.detail.endsWith('successor registered');
      expect(renewed).toBe(successorStart === 4060);
      expect(slotWarnings(report.warnings).length === 0).toBe(renewed);
    }
  });
});

describe('the words the CLI check finds warnings by', () => {
  it('are in the balance and slot warnings, and in no other warning the tool writes', () => {
    const report = buildVotingStatus({
      ...baseParams,
      // Below minVoterBalance, every slot used, an active key without a successor inside 45 days.
      balanceRaw: 2_999_999_999_999n,
      keys: [...baseParams.keys, { publicKey: 'C'.repeat(64), startEpoch: 4100, endEpoch: 4459 }],
    });
    const byWord = (word: string) => report.warnings.filter((w) => w.includes(word));
    expect(report.warnings).toHaveLength(3);
    expect(byWord(BELOW_MIN_VOTER_BALANCE)).toEqual([
      'Balance 2999999.999999 symbol.xym is below minVoterBalance 3000000.000000; the account cannot vote.',
    ]);
    expect(byWord(SLOTS_FULL)).toEqual([
      'All 3 voting key slots are used (1 expired). Unlink an expired key before registering a new one.',
    ]);
    // The third warning, about the expiring key, carries neither word.
    expect(byWord(`${'B'.repeat(8)}…`)).toHaveLength(1);
    const withoutActive = buildVotingStatus({ ...baseParams, keys: [] });
    expect(withoutActive.warnings.some((w) => w.includes(SLOTS_FULL))).toBe(false);
    expect(withoutActive.warnings.some((w) => w.includes(BELOW_MIN_VOTER_BALANCE))).toBe(false);
  });

  it('are not fooled by a currency alias from the node that carries them', () => {
    // The balance warning quotes the alias as the node sent it (cleaned, spaces kept), so an alias
    // with the words must not stand in for the slot warning in the CLI check's hint.
    const report = buildVotingStatus({
      ...baseParams,
      currencyAlias: `fake ${SLOTS_FULL} ${'B'.repeat(8)}…`,
      balanceRaw: 2_999_999_999_999n,
      keys: [...baseParams.keys, { publicKey: 'C'.repeat(64), startEpoch: 4100, endEpoch: 4459 }],
    });
    const slot =
      'All 3 voting key slots are used (1 expired). Unlink an expired key before registering a new one.';
    const balance = report.warnings.find((w) => w.includes(BELOW_MIN_VOTER_BALANCE));
    expect(balance).toContain(SLOTS_FULL);
    const hint = mapVotingKeys(report, 14).hint;
    expect(hint).toBe(`${balance} ${slot}`);
  });
});

describe('longestActiveKey', () => {
  it('picks the active key with the most days left', () => {
    const keys = [
      { status: 'expired' as const, remainingDays: 90 },
      { status: 'active' as const, remainingDays: 2 },
      { status: 'active' as const, remainingDays: 40 },
      { status: 'future' as const, remainingDays: 400 },
    ];
    expect(longestActiveKey(keys)?.remainingDays).toBe(40);
    expect(longestActiveKey(keys.filter((k) => k.status !== 'active'))).toBeUndefined();
  });
});

describe('the expiry warning window', () => {
  it('is 45 days, so a monthly check (at most 31 days apart) sees it 14 days before expiry at the latest', () => {
    expect(EXPIRY_WARNING_DAYS).toBe(45);
    expect(EXPIRY_WARNING_DAYS - 31).toBe(14);
  });

  // 30,000 ms per block: one day is 2,880 blocks. The active key 3700-4059 expires at height
  // (4059 - 1) x 1440; the current height is set that many days before it.
  const atDaysLeft = (days: number) => {
    const height = votingKeyExpiryHeight(4059, 1440) - Math.round(days * 2880);
    return buildVotingStatus({
      ...baseParams,
      averageBlockTimeMs: 30_000,
      currentHeight: height,
      currentEpoch: heightToEpoch(height, 1440),
    });
  };
  const expiryWarnings = (days: number) =>
    atDaysLeft(days).warnings.filter((w) => /no successor key is registered/.test(w));

  it('warns at 45.0 days left and not at 45.1', () => {
    expect(atDaysLeft(45).votingKeys.find((k) => k.status === 'active')?.remainingDays).toBe(45);
    expect(expiryWarnings(45)).toHaveLength(1);
    expect(atDaysLeft(45.1).votingKeys.find((k) => k.status === 'active')?.remainingDays).toBe(
      45.1,
    );
    expect(expiryWarnings(45.1)).toEqual([]);
  });

  it('warns at 31 days left, which the former 30-day window did not', () => {
    expect(expiryWarnings(31)).toHaveLength(1);
  });

  it('still respects a caller-supplied window', () => {
    const report = buildVotingStatus({
      ...baseParams,
      averageBlockTimeMs: 30_000,
      currentHeight: votingKeyExpiryHeight(4059, 1440) - 31 * 2880,
      currentEpoch: heightToEpoch(votingKeyExpiryHeight(4059, 1440) - 31 * 2880, 1440),
      warnWithinDays: 30,
    });
    expect(report.warnings.filter((w) => /no successor key is registered/.test(w))).toEqual([]);
  });
});
