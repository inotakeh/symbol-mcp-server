/**
 * Voting key lifecycle computation (pure; no I/O).
 *
 * A registered voting key {startEpoch, endEpoch} is usable during finalization epochs
 * startEpoch..endEpoch inclusive. Expired keys stay in `supplementalPublicKeys.voting` and keep
 * occupying one of `maxVotingKeysPerAccount` slots until the account unlinks them.
 */
import { formatAmount } from './amount.js';
import { epochStartHeight, votingKeyExpiryHeight } from './epoch.js';
import { summaryName } from './quote.js';
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
  /** Days before expiry at which a warning is raised; EXPIRY_WARNING_DAYS when not given. */
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
  /**
   * Not output fields: the currency and the warnings as the summary shows them, with an alias
   * outside the namespace grammar quoted (domain/quote.ts). `eligibility.currency` and `warnings`
   * keep the plain cleaned text.
   */
  readonly summaryCurrency: string;
  readonly summaryWarnings: readonly string[];
}

const RENEWAL_WINDOW_START_DAYS = 7;
/** The recommended renewal window closes this many days before expiry. */
export const RENEWAL_WINDOW_END_DAYS = 3;
/**
 * An active key without a successor is warned about from this many days before expiry (a policy
 * constant). A check run once a month is at most 31 days apart, so with 45 days every monthly run
 * sees the warning at least once, 14 days before expiry at the latest, before the recommended
 * renewal window opens (RENEWAL_WINDOW_START_DAYS). With 30 days, a run 30.5 days out saw nothing
 * and the next one came after the window had closed.
 */
export const EXPIRY_WARNING_DAYS = 45;
const DAY_MS = 86_400_000;

/**
 * Words of the warning about a balance below minVoterBalance, and of the warnings about full
 * voting key slots. The warnings are built with them, and the CLI check (src/cli/check.ts) finds
 * those warnings by them for its hints.
 */
export const BELOW_MIN_VOTER_BALANCE = 'is below minVoterBalance';
export const SLOTS_FULL = 'voting key slots are';

/**
 * True when a registered future key takes over without a gap, i.e. it starts no later than the
 * epoch after `key` ends. An expiring key with a successor needs no warning.
 */
export function hasSuccessorKey(
  key: { readonly endEpoch: number },
  futureKeys: ReadonlyArray<{ readonly startEpoch: number }>,
): boolean {
  return futureKeys.some((f) => f.startEpoch <= key.endEpoch + 1);
}

/**
 * The active key whose renewal matters: the one with the most days left. The slot warning below
 * and the CLI check's voting item (src/cli/check.ts) both judge renewal on this key with
 * hasSuccessorKey, so they agree on when a renewal is already done.
 */
export function longestActiveKey<
  K extends { readonly status: VotingKeyStatus; readonly remainingDays?: number | undefined },
>(keys: readonly K[]): K | undefined {
  return keys
    .filter((k) => k.status === 'active')
    .sort((a, b) => (b.remainingDays ?? 0) - (a.remainingDays ?? 0))[0];
}

export function buildVotingStatus(p: VotingStatusParams): VotingStatusReport {
  const G = p.votingSetGrouping;
  const warnWithinDays = p.warnWithinDays ?? EXPIRY_WARNING_DAYS;
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
  const summaryCurrency = p.currencyAlias ? summaryName('alias', p.currencyAlias) : currency;

  const warnings: string[] = [];
  const summaryWarnings: string[] = [];
  const warn = (plain: string, forSummary: string = plain) => {
    warnings.push(plain);
    summaryWarnings.push(forSummary);
  };
  const active = votingKeys.filter((k) => k.status === 'active');
  const future = votingKeys.filter((k) => k.status === 'future');
  if (active.length === 0) {
    warn(
      future.length > 0
        ? `No voting key is active for the current epoch ${p.currentEpoch}; the next key starts at epoch ${future[0]?.startEpoch}.`
        : 'No active voting key is registered for this account.',
    );
  }
  for (const key of active) {
    const days = key.remainingDays ?? 0;
    const covered = hasSuccessorKey(key, future);
    if (days <= warnWithinDays && !covered) {
      warn(
        `Active voting key ${key.publicKey.slice(0, 8)}… expires at epoch ${key.endEpoch} in about ${days} days (${key.expiresAt ? formatInstantText(key.expiresAt) : 'unknown time'}) and no successor key is registered.`,
      );
    }
  }
  if (!eligible) {
    const below = (label: string) =>
      `Balance ${formatAmount(p.balanceRaw, p.currencyDivisibility)} ${label} ${BELOW_MIN_VOTER_BALANCE} ${formatAmount(p.minVoterBalance, p.currencyDivisibility)}; the account cannot vote.`;
    warn(below(currency), below(summaryCurrency));
  }
  if (slotsFree === 0) {
    if (expiredCount > 0) {
      warn(
        `All ${p.maxVotingKeysPerAccount} ${SLOTS_FULL} used (${expiredCount} expired). Unlink an expired key before registering a new one.`,
      );
    } else {
      // No expired key to unlink. With the renewal already done (a successor without a gap, the
      // CLI check's rule), full slots need no action; otherwise say so without advice to unlink.
      const renewal = longestActiveKey(votingKeys);
      if (!renewal || !hasSuccessorKey(renewal, future)) {
        warn(
          `All ${p.maxVotingKeysPerAccount} ${SLOTS_FULL} taken by keys that have not expired, so there is no slot for a new key yet.`,
        );
      }
    }
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
    summaryCurrency,
    summaryWarnings,
  };
}
