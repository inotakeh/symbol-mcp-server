import * as z from 'zod/v4';
import { ChainInfoSchema } from '../client/schemas.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { parseHeight } from '../domain/epoch.js';
import { formatInstantText, roundTo } from '../domain/time.js';
import { buildVotingStatus } from '../domain/voting.js';
import { defineTool, formatInteger, nullable } from './_shared.js';
import { fetchAccount } from './symbol_account_get.js';

const InstantSchema = z.object({ utc: z.string(), local: z.string().optional() });

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe('Voting account to inspect: base32 address (39 chars) or hex public key (64 chars).'),
});

const VotingKeyReportSchema = z.object({
  publicKey: z.string(),
  startEpoch: z.number(),
  endEpoch: z.number(),
  status: z.enum(['expired', 'active', 'future']),
  lifetimeEpochs: z.number(),
  startHeight: z.number(),
  expiryHeight: z.number(),
  remainingEpochs: z.number().optional(),
  remainingBlocks: z.number().optional(),
  remainingDays: z.number().optional(),
  expiresAt: InstantSchema.optional(),
  startsAt: InstantSchema.optional(),
  recommendedRenewalWindow: z.object({ from: InstantSchema, to: InstantSchema }).optional(),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  account: z.object({
    address: z.string(),
    publicKey: nullable(
      z.string(),
      'Hex public key; null until the account has sent its first transaction.',
    ),
  }),
  current: z.object({
    height: z.number(),
    finalizedHeight: z.number(),
    finalizationEpoch: z.number(),
    votingSetGrouping: z.number(),
    averageBlockTimeSeconds: z.number(),
    averageBlockTimeSampleBlocks: z.number(),
    estimateNote: z.string(),
    checkedAt: InstantSchema,
  }),
  votingKeys: z.array(VotingKeyReportSchema),
  constraints: z.object({
    maxVotingKeysPerAccount: z.number(),
    minVotingKeyLifetime: z.number(),
    maxVotingKeyLifetime: z.number(),
    slotsUsed: z.number(),
    slotsFree: z.number(),
    expiredKeysOccupyingSlots: z.number(),
    note: z.string(),
  }),
  eligibility: z.object({
    balance: z.string(),
    rawBalance: z.string(),
    minVoterBalance: z.string(),
    rawMinVoterBalance: z.string(),
    eligible: z.boolean(),
    margin: z.string(),
    currency: z.string(),
  }),
  warnings: z.array(z.string()),
});

const ZERO_KEY = '0'.repeat(64);

export const votingKeyStatusTool = defineTool({
  name: 'symbol_voting_key_status',
  title: 'Symbol voting key status',
  description:
    'For a Symbol voting node account, list every registered voting key with its start/end epoch and status (expired, active, future), and for active or upcoming keys compute the remaining epochs, blocks and days, the estimated expiry date/time, and a recommended renewal window (7 to 3 days before expiry). Also reports the current finalization epoch, network limits (max keys per account, min/max key lifetime, free slots), whether the balance meets minVoterBalance, and warnings when no key is active or a key expires within 30 days.',
  inputSchema,
  outputSchema,
  run: async (ctx, { account }) => {
    const [{ info }, chain, { properties, currency }] = await Promise.all([
      fetchAccount(ctx, account),
      ctx.rest.get('/chain/info', ChainInfoSchema),
      ctx.getNetworkData(),
    ]);
    const currentHeight = parseHeight(chain.height);
    const finalizedHeight = parseHeight(chain.latestFinalizedBlock.height);
    const currentEpoch = chain.latestFinalizedBlock.finalizationEpoch;
    const blockTime = await ctx.getAverageBlockTime(currentHeight);
    const now = ctx.now();

    const acct = info.account;
    const address = hexAddressToBase32(acct.address);
    const keys = (acct.supplementalPublicKeys.voting?.publicKeys ?? []).map((k) => ({
      publicKey: k.publicKey.toUpperCase(),
      startEpoch: k.startEpoch,
      endEpoch: k.endEpoch,
    }));
    const balanceRaw = BigInt(
      acct.mosaics.find((m) => m.id.toUpperCase() === currency.mosaicId)?.amount ?? '0',
    );

    const report = buildVotingStatus({
      keys,
      currentEpoch,
      currentHeight,
      votingSetGrouping: properties.votingSetGrouping,
      averageBlockTimeMs: blockTime.averageBlockTimeMs,
      now,
      ...(ctx.config.timeZone ? { timeZone: ctx.config.timeZone } : {}),
      maxVotingKeysPerAccount: properties.maxVotingKeysPerAccount,
      minVotingKeyLifetime: properties.minVotingKeyLifetime,
      maxVotingKeyLifetime: properties.maxVotingKeyLifetime,
      balanceRaw,
      minVoterBalance: properties.minVoterBalance,
      currencyDivisibility: currency.divisibility,
      currencyAlias: currency.alias,
    });

    const active = report.votingKeys.filter((k) => k.status === 'active');
    const future = report.votingKeys.filter((k) => k.status === 'future');
    const expired = report.votingKeys.filter((k) => k.status === 'expired');
    const avgSeconds = roundTo(blockTime.averageBlockTimeMs / 1000, 2);

    const lines: string[] = [];
    lines.push(
      `${address} on ${ctx.network.name}: ${report.votingKeys.length} voting key${report.votingKeys.length === 1 ? '' : 's'} registered (${active.length} active, ${future.length} future, ${expired.length} expired); current finalization epoch ${currentEpoch}, height ${formatInteger(currentHeight)}.`,
    );
    for (const k of active) {
      lines.push(
        `Active key ${k.publicKey.slice(0, 8)}… (epochs ${k.startEpoch}-${k.endEpoch}) expires at height ${formatInteger(k.expiryHeight)}, in ${k.remainingEpochs} epochs / ${formatInteger(k.remainingBlocks ?? 0)} blocks / about ${k.remainingDays} days: estimated ${k.expiresAt ? formatInstantText(k.expiresAt) : 'unknown'}. Recommended renewal window: ${k.recommendedRenewalWindow ? `${formatInstantText(k.recommendedRenewalWindow.from)} to ${formatInstantText(k.recommendedRenewalWindow.to)}` : 'unknown'}.`,
      );
    }
    for (const k of future) {
      lines.push(
        `Future key ${k.publicKey.slice(0, 8)}… starts at epoch ${k.startEpoch} (about ${k.startsAt ? formatInstantText(k.startsAt) : 'unknown'}) and ends at epoch ${k.endEpoch}.`,
      );
    }
    lines.push(
      `Slots: ${report.constraints.slotsUsed}/${report.constraints.maxVotingKeysPerAccount} used (${report.constraints.expiredKeysOccupyingSlots} expired still occupying). Balance ${report.eligibility.balance} ${report.eligibility.currency} vs minVoterBalance ${report.eligibility.minVoterBalance}: ${report.eligibility.eligible ? 'eligible' : 'NOT eligible'}.`,
    );
    if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.join(' ')}`);
    lines.push(
      `Dates are estimates based on the measured average block time of ${avgSeconds}s over the last ${formatInteger(blockTime.sampleBlocks)} blocks.`,
    );

    return {
      summary: lines.join('\n'),
      network: ctx.network.name,
      account: {
        address,
        publicKey: acct.publicKey.toUpperCase() === ZERO_KEY ? null : acct.publicKey.toUpperCase(),
      },
      current: {
        height: currentHeight,
        finalizedHeight,
        finalizationEpoch: currentEpoch,
        votingSetGrouping: properties.votingSetGrouping,
        averageBlockTimeSeconds: avgSeconds,
        averageBlockTimeSampleBlocks: blockTime.sampleBlocks,
        estimateNote: `Future dates are estimates: (target height - current height) x measured average block time (${avgSeconds}s over blocks ${formatInteger(blockTime.fromHeight)}-${formatInteger(blockTime.toHeight)}), not the nominal ${properties.blockGenerationTargetTimeMs / 1000}s target.`,
        checkedAt: ctx.instant(now),
      },
      votingKeys: report.votingKeys.map((k) => ({ ...k })),
      constraints: report.constraints,
      eligibility: report.eligibility,
      warnings: [...report.warnings],
    };
  },
});
