/**
 * Shared plumbing for the transaction tools: zod output schemas for the summary shape produced by
 * domain/transaction.ts, and the lookups (mosaic aliases/divisibility, namespace names) that turn
 * a raw transaction into that summary.
 */
import * as z from 'zod/v4';
import {
  MosaicInfoListSchema,
  NamespaceInfoSchema,
  type TransactionInfo,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import {
  collectMosaicIds,
  collectRecipientNamespaceIds,
  type MosaicMeta,
  type SummarizeOptions,
} from '../domain/transaction.js';
import { TransactionDetailsSchema } from '../domain/txdetails.js';
import { nullable } from './_shared.js';

export const InstantSchema = z.object({ utc: z.string(), local: z.string().optional() });

export const TypeSchema = z.object({ code: z.number(), name: z.string() });

export const MessageSchema = z.object({
  kind: z.enum(['empty', 'plain', 'encrypted', 'persistentHarvestingDelegation', 'raw']),
  messageText: z
    .string()
    .optional()
    .describe('Untrusted third-party text (control characters stripped). Only for kind=plain.'),
  note: z.string().optional(),
  sizeBytes: z.number(),
});

export const MosaicSummarySchema = z.object({
  id: z.string(),
  alias: nullable(z.string(), 'Namespace alias such as symbol.xym; null when none is known.'),
  amount: z.string(),
  rawAmount: z.string(),
  divisibility: nullable(z.number(), 'Decimal places applied to amount; null when unknown.'),
});

export const RecipientSchema = z.object({
  address: nullable(z.string(), 'Base32 recipient address; null when the recipient is an alias.'),
  namespaceId: nullable(z.string(), 'Namespace id when the recipient is a namespace alias.'),
  namespaceName: nullable(z.string(), 'Resolved alias name (untrusted) when available.'),
});

export const SignerSchema = z.object({ publicKey: z.string(), address: z.string() });

export const EmbeddedSummarySchema = z.object({
  index: z.number(),
  type: TypeSchema,
  signer: SignerSchema,
  recipient: nullable(RecipientSchema, 'Recipient for transfers; null for other types.'),
  mosaics: z.array(MosaicSummarySchema),
  message: nullable(MessageSchema, 'Decoded message for transfers; null for other types.'),
  details: TransactionDetailsSchema,
});

export const TransactionSummarySchema = z.object({
  hash: nullable(z.string(), 'Transaction hash; null for embedded transactions.'),
  type: TypeSchema,
  height: nullable(z.number(), 'Block height; null while unconfirmed or partial.'),
  timestamp: nullable(InstantSchema, 'Block time; null while unconfirmed or partial.'),
  deadline: nullable(InstantSchema, 'Transaction deadline; null when the node did not report it.'),
  signer: SignerSchema,
  recipient: nullable(RecipientSchema, 'Recipient for transfers; null for other types.'),
  mosaics: z.array(MosaicSummarySchema),
  message: nullable(MessageSchema, 'Decoded message for transfers; null for other types.'),
  fee: z.object({
    maxFee: nullable(z.string(), 'Maximum fee in currency units; null when unknown.'),
    rawMaxFee: nullable(z.string(), 'Maximum fee as a raw integer; null when unknown.'),
    paidFee: nullable(
      z.string(),
      'Effective fee (size x block fee multiplier); null while unconfirmed.',
    ),
    rawPaidFee: nullable(z.string(), 'Effective fee as a raw integer; null while unconfirmed.'),
    feeMultiplier: nullable(
      z.number(),
      'Fee multiplier of the containing block; null while unconfirmed.',
    ),
    sizeBytes: nullable(z.number(), 'Serialized size in bytes; null when not reported.'),
  }),
  details: TransactionDetailsSchema.describe(
    'Type-specific fields keyed by kind (keyLink, votingKeyLink, namespaceRegistration, ...); kind "none" for transfers and aggregates.',
  ),
  innerTransactions: z.array(EmbeddedSummarySchema),
  cosignatureCount: z.number(),
});

/**
 * Resolves alias and divisibility for every mosaic id referenced by a batch of transactions with
 * a fixed number of requests: one `POST /namespaces/mosaic/names` and one `POST /mosaics`
 * regardless of how many ids there are. Only ids the node does not know as mosaics (absent from
 * the batch answer) fall back to a namespace lookup, in case they are namespace aliases.
 */
export async function resolveMosaicMeta(
  ctx: AppContext,
  ids: readonly string[],
): Promise<Map<string, MosaicMeta>> {
  const { currency } = await ctx.getNetworkData();
  const out = new Map<string, MosaicMeta>();
  const unique = [...new Set(ids.map((id) => id.toUpperCase()))];
  if (unique.includes(currency.mosaicId)) {
    out.set(currency.mosaicId, { alias: currency.alias, divisibility: currency.divisibility });
  }
  const others = unique.filter((id) => id !== currency.mosaicId);
  if (others.length === 0) return out;

  const [aliases, found] = await Promise.all([
    ctx.resolveMosaicAliases(others),
    ctx.rest.post('/mosaics', { mosaicIds: others }, MosaicInfoListSchema),
  ]);
  const divisibilityById = new Map(
    found.map((m) => [m.mosaic.id.toUpperCase(), m.mosaic.divisibility] as const),
  );
  const missing: string[] = [];
  for (const id of others) {
    const divisibility = divisibilityById.get(id);
    if (divisibility === undefined) missing.push(id);
    else out.set(id, { alias: aliases.get(id) ?? null, divisibility });
  }
  if (missing.length === 0) return out;

  // Fallback for ids that are not mosaics: they may be namespace ids used as aliases.
  const namespaces = await Promise.all(
    missing.map(async (id) => ({
      id,
      info: await ctx.rest.getOrNull(`/namespaces/${id}`, NamespaceInfoSchema),
    })),
  );
  const aliased = namespaces
    .map((n) => ({ id: n.id, target: n.info?.namespace.alias.mosaicId?.toUpperCase() }))
    .filter((n): n is { id: string; target: string } => n.target !== undefined);
  const targetsToFetch = [
    ...new Set(
      aliased
        .map((n) => n.target)
        .filter((t) => t !== currency.mosaicId && !divisibilityById.has(t)),
    ),
  ];
  const [names, targets] = await Promise.all([
    ctx.resolveNamespaceNames(aliased.map((n) => n.id)),
    targetsToFetch.length > 0
      ? ctx.rest.post('/mosaics', { mosaicIds: targetsToFetch }, MosaicInfoListSchema)
      : Promise.resolve([]),
  ]);
  for (const m of targets) divisibilityById.set(m.mosaic.id.toUpperCase(), m.mosaic.divisibility);
  for (const id of missing) {
    const target = aliased.find((n) => n.id === id)?.target;
    if (target === undefined) {
      out.set(id, { alias: aliases.get(id) ?? null, divisibility: null });
      continue;
    }
    out.set(id, {
      alias: names.get(id) ?? null,
      divisibility:
        target === currency.mosaicId
          ? currency.divisibility
          : (divisibilityById.get(target) ?? null),
    });
  }
  return out;
}

/** Builds the pure summariser options for a batch of transactions (one round of lookups). */
export async function buildSummarizeOptions(
  ctx: AppContext,
  infos: readonly TransactionInfo[],
): Promise<SummarizeOptions> {
  const { properties, currency } = await ctx.getNetworkData();
  const mosaicIds = [...new Set(infos.flatMap(collectMosaicIds))];
  const namespaceIds = [...new Set(infos.flatMap(collectRecipientNamespaceIds))];
  const [mosaicMeta, namespaceNames] = await Promise.all([
    resolveMosaicMeta(ctx, mosaicIds),
    ctx.resolveNamespaceNames(namespaceIds),
  ]);
  return {
    networkIdentifier: ctx.network.identifier,
    epochAdjustmentSeconds: properties.epochAdjustmentSeconds,
    currencyDivisibility: currency.divisibility,
    timeZone: ctx.config.timeZone,
    mosaicMeta,
    namespaceNames,
  };
}
