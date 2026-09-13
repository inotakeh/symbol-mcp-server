import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import { ChainInfoSchema, FinalizationProofSchema } from '../client/schemas.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { parseHeight } from '../domain/epoch.js';
import {
  type EpochParticipation,
  evaluateEpochParticipation,
  expandEpochRange,
  isKeyActiveForEpoch,
  type ProofInput,
  participationWarning,
  totalsOf,
} from '../domain/finality.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { fetchAccount } from './symbol_account_get.js';

/** Epochs checked per call; each is one GET, run under the client's concurrency cap. */
export const MAX_EPOCHS = 20;
const ZERO_KEY = '0'.repeat(64);

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe(
      'Voting account to check: base32 address (39 chars) or hex public key (64 chars). Hex addresses (48 chars) are also accepted.',
    ),
  epoch: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Finalization epoch to check. Omit for the latest finalized epoch reported by the node (/chain/info). Proofs exist only for finalized epochs.',
    ),
  epochs: z
    .number()
    .int()
    .min(1)
    .max(MAX_EPOCHS)
    .default(1)
    .describe(
      `How many consecutive epochs to check, counting back from epoch (epoch, epoch-1, ...). Default 1, at most ${MAX_EPOCHS}. One epoch is votingSetGrouping blocks (symbol_network_info); symbol_time_convert turns an epoch into a date.`,
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): per-stage details only for epochs that were not fully participated. detailed: per-stage details for every epoch.',
    ),
});

const StageSchema = z.object({
  stage: z.number().describe('StageEnum value: 0 prevote, 1 precommit, 2 count.'),
  stageName: z.string(),
  height: z.number(),
  signatureCount: z
    .number()
    .describe(
      'Voters whose signature is in this stage of the proof. The total number of registered voters is not known to this server.',
    ),
  participated: z.boolean(),
  matchedPublicKey: nullable(
    z.string(),
    "The account's voting key found among the signers; null when none of its keys signed.",
  ),
});

const EpochSchema = z.object({
  epoch: z.number(),
  status: z.enum(['participated', 'missed', 'no_active_key', 'unavailable']),
  finalizationPoint: nullable(
    z.number(),
    'Finalization point of the proof; null when unavailable.',
  ),
  height: nullable(z.number(), 'Finalized height of the proof; null when unavailable.'),
  proofHash: nullable(z.string(), 'Hash of the finalized block; null when unavailable.'),
  stages: z
    .array(StageSchema)
    .optional()
    .describe(
      'Per-stage detail, ascending by stage. Omitted for participated epochs in concise format; empty when the proof is unavailable.',
    ),
  participatedAllStages: z.boolean(),
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
    votingKeys: z.array(
      z.object({
        publicKey: z.string(),
        startEpoch: z.number(),
        endEpoch: z.number(),
        activeForEpoch: z
          .boolean()
          .describe('Whether this key covers the requested (most recent) epoch.'),
      }),
    ),
  }),
  current: z.object({
    finalizationEpoch: z.number(),
    finalizedHeight: z.number(),
    height: z.number(),
  }),
  requested: z.object({ epoch: z.number(), epochs: z.number() }),
  epochs: z.array(EpochSchema).describe('Most recent epoch first.'),
  totals: z.object({
    checked: z.number(),
    participated: z.number(),
    missed: z.number(),
    noActiveKey: z.number(),
    unavailable: z.number(),
  }),
  warning: nullable(
    z.string(),
    'About voting NOW: set when no registered key covers the current finalization epoch (whatever was requested), or when the current epoch was requested and missed. Historical epochs never warn; see epochs[].status.',
  ),
  notes: z.array(z.string()),
});

const NOTES = [
  "participated means one of the account's registered voting keys is among the root signers of every stage of the proof (prevote and precommit); signing only one stage counts as missed.",
  'signatureCount is the number of voters whose signature appears in that stage. The total number of registered voting nodes is not known to this server, so a shortfall can only be judged against an external list such as nodewatch.',
  'unavailable means the node holds no proof for that epoch (not yet finalized, or outside the history it keeps); it says nothing about whether the account voted.',
  "Only this account's keys are reported; other voters' public keys are not included.",
];

function stageCounts(r: EpochParticipation): string {
  return r.stages.map((s) => `${s.stageName} ${s.signatureCount} signatures`).join(', ');
}

function describeEpoch(r: EpochParticipation): string {
  switch (r.status) {
    case 'participated':
      return `Epoch ${r.epoch}: participated (${stageCounts(r)}; proof at height ${formatInteger(r.height ?? 0)}, point ${r.finalizationPoint}).`;
    case 'missed': {
      const signed = r.stages.filter((s) => s.participated).map((s) => s.stageName);
      const missed = r.stages.filter((s) => !s.participated).map((s) => s.stageName);
      const detail =
        signed.length > 0
          ? `signed ${signed.join(' and ')} only, not ${missed.join(' or ')}`
          : "the account's key signed neither stage";
      return `Epoch ${r.epoch}: MISSED, ${detail} (${stageCounts(r)}).`;
    }
    case 'no_active_key':
      return `Epoch ${r.epoch}: no registered voting key covers this epoch (${stageCounts(r)}).`;
    default:
      return `Epoch ${r.epoch}: proof not available on this node.`;
  }
}

export const finalityParticipationTool = defineTool({
  name: 'symbol_finality_participation',
  title: 'Symbol finality voting participation',
  description:
    "Check whether a Symbol account's voting key actually took part in finalization voting: for the requested epoch (default: the latest finalized one) and optionally the N epochs before it, read the finalization proof from the node and report per epoch whether one of the account's registered voting keys signed both stages (prevote and precommit), only one, or none, plus the number of signatures in each stage. Use it after a voting key renewal to confirm the new key votes, and for periodic voting-node health checks. symbol_voting_key_status tells when a key expires; this tool tells whether it is used.",
  inputSchema,
  outputSchema,
  run: async (ctx, { account, epoch, epochs, format }) => {
    const [{ info }, chain] = await Promise.all([
      fetchAccount(ctx, account),
      ctx.rest.get('/chain/info', ChainInfoSchema),
    ]);
    const acct = info.account;
    const address = hexAddressToBase32(acct.address);
    const keys = (acct.supplementalPublicKeys.voting?.publicKeys ?? []).map((k) => ({
      publicKey: k.publicKey.toUpperCase(),
      startEpoch: k.startEpoch,
      endEpoch: k.endEpoch,
    }));
    const latestEpoch = chain.latestFinalizedBlock.finalizationEpoch;
    const target = epoch ?? latestEpoch;
    const epochList = expandEpochRange(target, epochs);

    const proofs = await Promise.all(
      epochList.map(async (e) => {
        const path = `/finalization/proof/epoch/${e}`;
        const proof = await ctx.rest.getOrNull(path, FinalizationProofSchema);
        if (proof && proof.finalizationEpoch !== e) {
          throw new RestError(
            'invalid_response',
            `${ctx.rest.host} answered epoch ${proof.finalizationEpoch} for ${path}`,
            path,
          );
        }
        return proof;
      }),
    );

    if (proofs.every((p) => p === null)) {
      const range =
        epochList.length === 1
          ? `epoch ${target}`
          : `epochs ${target} down to ${epochList[epochList.length - 1]}`;
      const why =
        target > latestEpoch
          ? `epoch ${target} is above the latest finalized epoch ${latestEpoch}, and proofs exist only for finalized epochs`
          : 'nodes keep finalization proofs for a limited history';
      throw new ToolInputError(
        `No finalization proof for ${range} is available on ${ctx.rest.host} (${why}). Omit epoch to check the latest finalized epoch (${latestEpoch}), use a smaller epochs value, or point SYMBOL_NODE_URL at a node that keeps more history.`,
      );
    }

    const results = epochList.map((e, i) => {
      const proof = proofs[i];
      const input: ProofInput | null = proof
        ? {
            finalizationEpoch: proof.finalizationEpoch,
            finalizationPoint: proof.finalizationPoint,
            height: parseHeight(proof.height),
            hash: proof.hash,
            messageGroups: proof.messageGroups.map((g) => ({
              stage: g.stage,
              height: parseHeight(g.height),
              rootPublicKeys: g.signatures.map((s) => s.root.parentPublicKey),
            })),
          }
        : null;
      return evaluateEpochParticipation(e, keys, input);
    });
    const totals = totalsOf(results);
    const warning = participationWarning(results, keys, latestEpoch);
    const activeNow = keys.filter((k) => isKeyActiveForEpoch(k, target));

    const lines = [
      `${address} on ${ctx.network.name}: ${results.length} epoch${results.length === 1 ? '' : 's'} checked (${epochList.length === 1 ? `epoch ${target}` : `epochs ${target} down to ${epochList[epochList.length - 1]}`}; latest finalized epoch ${latestEpoch}): ${totals.participated} participated, ${totals.missed} missed, ${totals.noActiveKey} without an active key, ${totals.unavailable} unavailable.`,
      `Voting keys: ${keys.length} registered, ${activeNow.length} cover${activeNow.length === 1 ? 's' : ''} epoch ${target}${activeNow.length > 0 ? ` (${activeNow.map((k) => `${k.publicKey.slice(0, 8)}… epochs ${k.startEpoch}-${k.endEpoch}`).join(', ')})` : ''}.`,
      ...results.map(describeEpoch),
    ];
    if (warning) lines.push(`Warning: ${warning}`);
    if (target > latestEpoch) {
      lines.push(
        `Note: epoch ${target} is above the latest finalized epoch ${latestEpoch}; proofs exist only for finalized epochs.`,
      );
    }

    return {
      summary: lines.join('\n'),
      network: ctx.network.name,
      account: {
        address,
        publicKey: acct.publicKey.toUpperCase() === ZERO_KEY ? null : acct.publicKey.toUpperCase(),
        votingKeys: keys.map((k) => ({ ...k, activeForEpoch: isKeyActiveForEpoch(k, target) })),
      },
      current: {
        finalizationEpoch: latestEpoch,
        finalizedHeight: parseHeight(chain.latestFinalizedBlock.height),
        height: parseHeight(chain.height),
      },
      requested: { epoch: target, epochs },
      epochs: results.map((r) => {
        const { stages, ...rest } = r;
        return format === 'concise' && r.status === 'participated'
          ? rest
          : { ...rest, stages: stages.map((s) => ({ ...s })) };
      }),
      totals,
      warning,
      notes: NOTES,
    };
  },
});
