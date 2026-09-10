/**
 * Voting key lifecycle computation (pure; no I/O).
 *
 * A registered voting key {startEpoch, endEpoch} is usable during finalization epochs
 * startEpoch..endEpoch inclusive. Expired keys stay in `supplementalPublicKeys.voting` and keep
 * occupying one of `maxVotingKeysPerAccount` slots until the account unlinks them.
 */
import { formatAmount } from './amount.js';
import { epochStartHeight, votingKeyExpiryHeight } from './epoch.js';
import {
  estimateDateAtHeight,
  formatInstant,
  formatInstantText,
  type Instant,
  msToDays,
  roundTo,
} from './time.js';

export type VotingKeyStatus = 'expired' | 'active' | 'future';

export interface VotingKeyInput {
  readonly publicKey: string;
  readonly startEpoch: number;
  readonly endEpoch: number;
}

export function classifyVotingKey(key: VotingKeyInput, currentEpoch: number): VotingKeyStatus {
  if (key.endEpoch < currentEpoch) return 'expired';
  if (key.startEpoch > currentEpoch) return 'future';
  return 'active';
}

export interface VotingKeyReport {
  readonly publicKey: string;
  readonly startEpoch: number;
  readonly endEpoch: number;
  readonly status: VotingKeyStatus;
  readonly lifetimeEpochs: number;
  readonly startHeight: number;
  readonly expiryHeight: number;
  readonly remainingEpochs?: number;
  readonly remainingBlocks?: number;
  readonly remainingDays?: number;
  readonly expiresAt?: Instant;
  readonly startsAt?: Instant;
  readonly recommendedRenewalWindow?: { readonly from: Instant; readonly to: Instant };
}

export interface VotingStatusParams {
  readonly keys: readonly VotingKeyInput[];
  readonly currentEpoch: number;
  readonly currentHeight: number;
  readonly votingSetGrouping: number;
  readonly averageBlockTimeMs: number;
  readonly now: Date;
  readonly timeZone?: string;
  readonly maxVotingKeysPerAccount: number;
  readonly minVotingKeyLifetime: number;
  readonly maxVotingKeyLifetime: number;
  readonly balanceRaw: bigint;
  readonly minVoterBalance: bigint;
  readonly currencyDivisibility: number;
  readonly currencyAlias: string | null;
  /** Days before expiry at which a warning is raised. */
  readonly warnWithinDays?: number;
}

export interface VotingStatusReport {
  readonly votingKeys: readonly VotingKeyReport[];
  readonly constraints: {
    readonly maxVotingKeysPerAccount: number;
    readonly minVotingKeyLifetime: number;
    readonly maxVotingKeyLifetime: number;
    readonly slotsUsed: number;
    readonly slotsFree: number;
    readonly expiredKeysOccupyingSlots: number;
    readonly note: string;
  };
  readonly eligibility: {
    readonly balance: string;
    readonly rawBalance: string;
    readonly minVoterBalance: string;
    readonly rawMinVoterBalance: string;
    readonly eligible: boolean;
    readonly margin: string;
    readonly currency: string;
  };
  readonly warnings: readonly string[];
}

const RENEWAL_WINDOW_START_DAYS = 7;
const RENEWAL_WINDOW_END_DAYS = 3;
const DAY_MS = 86_400_000;

export function buildVotingStatus(p: VotingStatusParams): VotingStatusReport {
  const G = p.votingSetGrouping;
  const warnWithinDays = p.warnWithinDays ?? 30;
  const estimate = (height: number) =>
    estimateDateAtHeight(p.currentHeight, height, p.averageBlockTimeMs, p.now);

  const votingKeys: VotingKeyReport[] = [...p.keys]
    .sort((a, b) => a.startEpoch - b.startEpoch)
    .map((key) => {
      const status = classifyVotingKey(key, p.currentEpoch);
      const startHeight = epochStartHeight(key.startEpoch, G);
      const expiryHeight = votingKeyExpiryHeight(key.endEpoch, G);
      const base: VotingKeyReport = {
        publicKey: key.publicKey,
        startEpoch: key.startEpoch,
        endEpoch: key.endEpoch,
        status,
        lifetimeEpochs: key.endEpoch - key.startEpoch + 1,
        startHeight,
        expiryHeight,
      };
      if (status === 'expired') return base;

      const expiresAtDate = estimate(expiryHeight);
      const remainingBlocks = expiryHeight - p.currentHeight;
      const report: VotingKeyReport = {
        ...base,
        remainingEpochs: key.endEpoch - p.currentEpoch,
        remainingBlocks,
        remainingDays: roundTo(msToDays(remainingBlocks * p.averageBlockTimeMs), 1),
        expiresAt: formatInstant(expiresAtDate, p.timeZone),
        recommendedRenewalWindow: {
          from: formatInstant(
            new Date(expiresAtDate.getTime() - RENEWAL_WINDOW_START_DAYS * DAY_MS),
            p.timeZone,
          ),
          to: formatInstant(
            new Date(expiresAtDate.getTime() - RENEWAL_WINDOW_END_DAYS * DAY_MS),
            p.timeZone,
          ),
        },
      };
      if (status === 'future') {
        return { ...report, startsAt: formatInstant(estimate(startHeight), p.timeZone) };
      }
      return report;
    });

  const slotsUsed = votingKeys.length;
  const expiredCount = votingKeys.filter((k) => k.status === 'expired').length;
  const slotsFree = Math.max(0, p.maxVotingKeysPerAccount - slotsUsed);

  const eligible = p.balanceRaw >= p.minVoterBalance;
  const currency = p.currencyAlias ?? 'currency mosaic';

  const warnings: string[] = [];
  const active = votingKeys.filter((k) => k.status === 'active');
  const future = votingKeys.filter((k) => k.status === 'future');
  if (active.length === 0) {
    warnings.push(
      future.length > 0
        ? `No voting key is active for the current epoch ${p.currentEpoch}; the next key starts at epoch ${future[0]?.startEpoch}.`
        : 'No active voting key is registered for this account.',
    );
  }
  for (const key of active) {
    const days = key.remainingDays ?? 0;
    const covered = future.some((f) => f.startEpoch <= key.endEpoch + 1);
    if (days <= warnWithinDays && !covered) {
      warnings.push(
        `Active voting key ${key.publicKey.slice(0, 8)}… expires at epoch ${key.endEpoch} in about ${days} days (${key.expiresAt ? formatInstantText(key.expiresAt) : 'unknown time'}) and no successor key is registered.`,
      );
    }
  }
  if (!eligible) {
    warnings.push(
      `Balance ${formatAmount(p.balanceRaw, p.currencyDivisibility)} ${currency} is below minVoterBalance ${formatAmount(p.minVoterBalance, p.currencyDivisibility)}; the account cannot vote.`,
    );
  }
  if (slotsFree === 0) {
    warnings.push(
      `All ${p.maxVotingKeysPerAccount} voting key slots are used (${expiredCount} expired). Unlink an expired key before registering a new one.`,
    );
  }

  return {
    votingKeys,
    constraints: {
      maxVotingKeysPerAccount: p.maxVotingKeysPerAccount,
      minVotingKeyLifetime: p.minVotingKeyLifetime,
      maxVotingKeyLifetime: p.maxVotingKeyLifetime,
      slotsUsed,
      slotsFree,
      expiredKeysOccupyingSlots: expiredCount,
      note: 'Expired voting keys remain registered and occupy a slot until they are unlinked.',
    },
    eligibility: {
      balance: formatAmount(p.balanceRaw, p.currencyDivisibility),
      rawBalance: p.balanceRaw.toString(),
      minVoterBalance: formatAmount(p.minVoterBalance, p.currencyDivisibility),
      rawMinVoterBalance: p.minVoterBalance.toString(),
      eligible,
      margin: formatAmount(p.balanceRaw - p.minVoterBalance, p.currencyDivisibility),
      currency,
    },
    warnings,
  };
}
