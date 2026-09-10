import * as z from 'zod/v4';
import { ChainInfoSchema } from '../client/schemas.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { parseHeight } from '../domain/epoch.js';
import { UNLIMITED_END_HEIGHT } from '../domain/namespace.js';
import { estimateDateAtHeight, formatInstantText, msToDays, roundTo } from '../domain/time.js';
import { fetchNamespace, namespaceLevels, resolveNamespaceInput } from './_namespaces.js';
import { defineTool, formatInteger, nullable } from './_shared.js';
import { InstantSchema } from './_transactions.js';

const inputSchema = z.object({
  namespace: z
    .string()
    .min(1)
    .describe(
      'Namespace to look up: dotted name such as symbol.xym or its 16-character hex id such as E74B99BA41F4AFEE.',
    ),
});

const AliasSchema = z.object({
  type: z.enum(['none', 'mosaic', 'address']),
  mosaicId: nullable(z.string(), 'Aliased mosaic id when type is mosaic.'),
  address: nullable(z.string(), 'Aliased base32 address when type is address.'),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  id: z.string(),
  name: nullable(z.string(), 'Full dotted name (untrusted, sanitized); null when unresolvable.'),
  registrationType: z.enum(['root', 'sub']),
  depth: z.number(),
  levels: z.array(
    z.object({
      id: z.string(),
      name: nullable(z.string(), 'Name of this level; null when unresolvable.'),
    }),
  ),
  parentId: nullable(z.string(), 'Parent namespace id; null for a root namespace.'),
  owner: z.string(),
  alias: AliasSchema,
  active: nullable(
    z.boolean(),
    'Whether the node reports the namespace as active; null if not reported.',
  ),
  startHeight: z.number(),
  endHeight: nullable(z.number(), 'Last valid height; null when the namespace never expires.'),
  unlimited: z.boolean(),
  remainingBlocks: nullable(z.number(), 'Blocks until expiry; null when unlimited or expired.'),
  remainingDays: nullable(
    z.number(),
    'Estimated days until expiry; null when unlimited or expired.',
  ),
  expired: z.boolean(),
  expiresAt: nullable(InstantSchema, 'Estimated expiry time; null when unlimited.'),
  estimateNote: nullable(z.string(), 'How expiresAt was estimated; null when unlimited.'),
});

const ALIAS_TYPES = { 0: 'none', 1: 'mosaic', 2: 'address' } as const;

export const namespaceGetTool = defineTool({
  name: 'symbol_namespace_get',
  title: 'Symbol namespace details',
  description:
    'Describe a Symbol namespace by name (e.g. symbol.xym) or hex id: owner address, root or sub namespace, every level with its name, alias target (mosaic id or address), start and end height, and the estimated expiry date and remaining blocks (root namespaces registered forever report unlimited).',
  inputSchema,
  outputSchema,
  run: async (ctx, { namespace }) => {
    const resolved = resolveNamespaceInput(namespace);
    const info = await fetchNamespace(ctx, resolved);
    const ns = info.namespace;
    const levelIds = namespaceLevels(info);
    const names = await ctx.resolveNamespaceNames(levelIds);
    const levels = levelIds.map((id) => ({ id, name: names.get(id) ?? null }));
    const fullName = names.get(resolved.id) ?? resolved.name ?? null;

    const aliasType = ALIAS_TYPES[ns.alias.type as 0 | 1 | 2] ?? 'none';
    const alias = {
      type: aliasType,
      mosaicId:
        aliasType === 'mosaic' && ns.alias.mosaicId ? ns.alias.mosaicId.toUpperCase() : null,
      address:
        aliasType === 'address' && ns.alias.address ? hexAddressToBase32(ns.alias.address) : null,
    };

    const startHeight = parseHeight(ns.startHeight);
    const unlimited =
      ns.endHeight === UNLIMITED_END_HEIGHT ||
      BigInt(ns.endHeight) > BigInt(Number.MAX_SAFE_INTEGER);
    let endHeight: number | null = null;
    let remainingBlocks: number | null = null;
    let expiresAt: { utc: string; local?: string } | null = null;
    let expired = false;
    let estimateNote: string | null = null;
    let remainingDays: number | null = null;
    if (!unlimited) {
      endHeight = parseHeight(ns.endHeight);
      const chain = await ctx.rest.get('/chain/info', ChainInfoSchema);
      const currentHeight = parseHeight(chain.height);
      const blockTime = await ctx.getAverageBlockTime(currentHeight);
      const { properties } = await ctx.getNetworkData();
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
      estimateNote = `Estimated from the measured average block time (${avgSeconds}s over the last ${formatInteger(blockTime.sampleBlocks)} blocks), not the nominal ${properties.blockGenerationTargetTimeMs / 1000}s target. Sub-namespaces expire with their root.`;
    }

    const owner = hexAddressToBase32(ns.ownerAddress);
    const parentId = ns.registrationType === 0 ? null : (ns.parentId?.toUpperCase() ?? null);
    const aliasText =
      alias.type === 'mosaic'
        ? `alias for mosaic ${alias.mosaicId}`
        : alias.type === 'address'
          ? `alias for address ${alias.address}`
          : 'no alias';
    const lifetime = unlimited
      ? 'never expires'
      : expired
        ? `expired at height ${formatInteger(endHeight ?? 0)}`
        : `expires at height ${formatInteger(endHeight ?? 0)} in ${formatInteger(remainingBlocks ?? 0)} blocks (about ${remainingDays} days), estimated ${expiresAt ? formatInstantText(expiresAt) : 'unknown'}`;
    const summary = `Namespace ${fullName ?? resolved.id} (${resolved.id}) on ${ctx.network.name}: ${ns.registrationType === 0 ? 'root' : `sub-namespace of ${parentId}`}, depth ${ns.depth}, ${aliasText}; owner ${owner}; registered at height ${formatInteger(startHeight)}, ${lifetime}.`;

    return {
      summary,
      network: ctx.network.name,
      id: resolved.id,
      name: fullName,
      registrationType: ns.registrationType === 0 ? ('root' as const) : ('sub' as const),
      depth: ns.depth,
      levels,
      parentId,
      owner,
      alias,
      active: info.meta.active ?? null,
      startHeight,
      endHeight,
      unlimited,
      remainingBlocks,
      remainingDays,
      expired,
      expiresAt,
      estimateNote,
    };
  },
});
