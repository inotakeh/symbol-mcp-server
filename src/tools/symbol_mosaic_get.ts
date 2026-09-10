import * as z from 'zod/v4';
import { ChainInfoSchema, MosaicInfoSchema, NamespaceInfoSchema } from '../client/schemas.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount } from '../domain/amount.js';
import { parseHeight } from '../domain/epoch.js';
import { isHexNamespaceId } from '../domain/namespace.js';
import { estimateDateAtHeight, formatInstantText, msToDays, roundTo } from '../domain/time.js';
import { fetchNamespace, resolveNamespaceInput } from './_namespaces.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';

const inputSchema = z.object({
  mosaic: z
    .string()
    .min(1)
    .describe(
      'Mosaic to look up: 16-character hex id (e.g. 6BED913FA20223F8) or an alias name such as symbol.xym.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  id: z.string(),
  alias: nullable(z.string(), 'Namespace alias such as symbol.xym; null when the mosaic has none.'),
  supply: z.object({ amount: z.string(), raw: z.string() }),
  divisibility: z.number(),
  flags: z.object({
    supplyMutable: z.boolean(),
    transferable: z.boolean(),
    restrictable: z.boolean(),
    revokable: z.boolean(),
    raw: z.number(),
  }),
  owner: z.string(),
  startHeight: z.number(),
  duration: z.object({
    blocks: z.number(),
    unlimited: z.boolean(),
    endHeight: nullable(z.number(), 'Last valid height; null when the mosaic never expires.'),
    remainingBlocks: nullable(z.number(), 'Blocks until expiry; null when unlimited or expired.'),
    remainingDays: nullable(
      z.number(),
      'Estimated days until expiry; null when unlimited or expired.',
    ),
    expiresAt: nullable(InstantSchema, 'Estimated expiry time; null when unlimited.'),
    expired: z.boolean(),
    estimateNote: nullable(z.string(), 'How expiresAt was estimated; null when unlimited.'),
  }),
  revision: nullable(z.number(), 'Definition revision; null when not reported.'),
});

/** MosaicFlags bit values from catbuffer (mosaic/mosaic_types.cats). */
const FLAG_SUPPLY_MUTABLE = 1;
const FLAG_TRANSFERABLE = 2;
const FLAG_RESTRICTABLE = 4;
const FLAG_REVOKABLE = 8;

export const mosaicGetTool = defineTool({
  name: 'symbol_mosaic_get',
  title: 'Symbol mosaic details',
  description:
    'Describe a Symbol mosaic (token) by hex id or alias name such as symbol.xym: alias, total supply (divisibility-adjusted and raw), divisibility, flags (supplyMutable, transferable, restrictable, revokable), owner address, start height, and duration with the estimated expiry date (duration 0 means unlimited).',
  inputSchema,
  outputSchema,
  run: async (ctx, { mosaic }) => {
    const trimmed = mosaic.trim();
    let mosaicId: string;
    let aliasFromName: string | undefined;
    if (isHexNamespaceId(trimmed) && !trimmed.includes('.')) {
      // A 16-hex value may be a mosaic id or a namespace id (alias); try the mosaic first.
      mosaicId = trimmed.toUpperCase();
    } else {
      const resolved = resolveNamespaceInput(trimmed);
      const ns = await fetchNamespace(ctx, resolved);
      const aliased = ns.namespace.alias.mosaicId;
      if (ns.namespace.alias.type !== 1 || !aliased) {
        throw new ToolInputError(
          `Namespace "${resolved.name ?? resolved.id}" exists but is not an alias for a mosaic (alias type ${ns.namespace.alias.type}). Use symbol_namespace_get to inspect it, or pass the mosaic hex id.`,
        );
      }
      mosaicId = aliased.toUpperCase();
      aliasFromName = resolved.name;
    }

    let info = await ctx.rest.getOrNull(`/mosaics/${mosaicId}`, MosaicInfoSchema);
    if (!info && !aliasFromName) {
      // Maybe the hex value was a namespace id that aliases a mosaic.
      const ns = await ctx.rest.getOrNull(`/namespaces/${mosaicId}`, NamespaceInfoSchema);
      const aliased = ns?.namespace.alias.mosaicId;
      if (ns && ns.namespace.alias.type === 1 && aliased) {
        mosaicId = aliased.toUpperCase();
        info = await ctx.rest.getOrNull(`/mosaics/${mosaicId}`, MosaicInfoSchema);
      }
    }
    if (!info) {
      throw new ToolInputError(
        `Mosaic ${mosaicId} does not exist on ${ctx.network.name} (node ${ctx.rest.host}). Check the id (16 hex characters) or use an alias name such as symbol.xym, and whether you meant mainnet or testnet.`,
      );
    }

    const m = info.mosaic;
    const [aliases, { properties }] = await Promise.all([
      ctx.resolveMosaicAliases([mosaicId]),
      ctx.getNetworkData(),
    ]);
    const alias = aliases.get(mosaicId) ?? aliasFromName ?? null;
    const startHeight = parseHeight(m.startHeight);
    const durationBlocks = Number(
      BigInt(m.duration) > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : m.duration,
    );
    const unlimited = durationBlocks === 0;

    let endHeight: number | null = null;
    let remainingBlocks: number | null = null;
    let expiresAt: { utc: string; local?: string } | null = null;
    let expired = false;
    let estimateNote: string | null = null;
    let remainingDays: number | null = null;
    if (!unlimited) {
      endHeight = startHeight + durationBlocks;
      const chain = await ctx.rest.get('/chain/info', ChainInfoSchema);
      const currentHeight = parseHeight(chain.height);
      const blockTime = await ctx.getAverageBlockTime(currentHeight);
      expired = endHeight <= currentHeight;
      remainingBlocks = expired ? null : endHeight - currentHeight;
      remainingDays =
        remainingBlocks === null
          ? null
          : roundTo(msToDays(remainingBlocks * blockTime.averageBlockTimeMs), 1);
      expiresAt = ctx.instant(
        estimateDateAtHeight(currentHeight, endHeight, blockTime.averageBlockTimeMs, ctx.now()),
      );
      const avgSeconds = roundTo(blockTime.averageBlockTimeMs / 1000, 2);
      estimateNote = `Estimated from the measured average block time (${avgSeconds}s over the last ${formatInteger(blockTime.sampleBlocks)} blocks), not the nominal ${properties.blockGenerationTargetTimeMs / 1000}s target.`;
    }

    const flags = {
      supplyMutable: (m.flags & FLAG_SUPPLY_MUTABLE) !== 0,
      transferable: (m.flags & FLAG_TRANSFERABLE) !== 0,
      restrictable: (m.flags & FLAG_RESTRICTABLE) !== 0,
      revokable: (m.flags & FLAG_REVOKABLE) !== 0,
      raw: m.flags,
    };
    const supply = formatAmount(m.supply, m.divisibility);
    const owner = hexAddressToBase32(m.ownerAddress);
    const flagNames = Object.entries(flags)
      .filter(([k, v]) => k !== 'raw' && v === true)
      .map(([k]) => k);

    const summary = [
      `Mosaic ${mosaicId}${alias ? ` (${alias})` : ''} on ${ctx.network.name}: supply ${supply}, divisibility ${m.divisibility}, flags ${flagNames.length > 0 ? flagNames.join('/') : 'none'}.`,
      `Owner ${owner}; registered at height ${formatInteger(startHeight)}; ${
        unlimited
          ? 'unlimited duration (never expires).'
          : expired
            ? `expired at height ${formatInteger(endHeight ?? 0)}.`
            : `expires at height ${formatInteger(endHeight ?? 0)} in ${formatInteger(remainingBlocks ?? 0)} blocks (about ${remainingDays} days), estimated ${expiresAt ? formatInstantText(expiresAt) : 'unknown'}.`
      }`,
    ].join('\n');

    return {
      summary,
      network: ctx.network.name,
      id: mosaicId,
      alias,
      supply: { amount: supply, raw: m.supply },
      divisibility: m.divisibility,
      flags,
      owner,
      startHeight,
      duration: {
        blocks: durationBlocks,
        unlimited,
        endHeight,
        remainingBlocks,
        remainingDays,
        expiresAt,
        expired,
        estimateNote,
      },
      revision: m.revision ?? null,
    };
  },
});
