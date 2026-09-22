/**
 * Mosaic argument resolution shared by symbol_mosaic_get and symbol_account_rank: a 16-hex mosaic
 * id, a 16-hex namespace id that aliases a mosaic, or an alias name such as symbol.xym.
 */
import { type MosaicInfo, MosaicInfoSchema, NamespaceInfoSchema } from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { isHexNamespaceId } from '../domain/namespace.js';
import { fetchNamespace, resolveNamespaceInput } from './_namespaces.js';
import { ToolInputError } from './_shared.js';

/** AliasTypeEnum value for a mosaic alias (symbol-openapi AliasTypeEnum.yml). */
const ALIAS_MOSAIC = 1;

export interface ResolvedMosaic {
  /** Upper-case 16-hex mosaic id. */
  readonly mosaicId: string;
  readonly info: MosaicInfo;
  /** The alias name the caller typed, when the argument was a name. */
  readonly aliasFromName?: string;
}

/**
 * Turns a mosaic argument into its definition (`GET /mosaics/{id}`). Throws ToolInputError with
 * a hint when the name is not a mosaic alias or the mosaic does not exist on this network.
 */
export async function resolveMosaicInput(ctx: AppContext, value: string): Promise<ResolvedMosaic> {
  const trimmed = value.trim();
  let mosaicId: string;
  let aliasFromName: string | undefined;
  if (isHexNamespaceId(trimmed) && !trimmed.includes('.')) {
    // A 16-hex value may be a mosaic id or a namespace id (alias); try the mosaic first.
    mosaicId = trimmed.toUpperCase();
  } else {
    const resolved = resolveNamespaceInput(trimmed);
    const ns = await fetchNamespace(ctx, resolved);
    const aliased = ns.namespace.alias.mosaicId;
    if (ns.namespace.alias.type !== ALIAS_MOSAIC || !aliased) {
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
    if (ns && ns.namespace.alias.type === ALIAS_MOSAIC && aliased) {
      mosaicId = aliased.toUpperCase();
      info = await ctx.rest.getOrNull(`/mosaics/${mosaicId}`, MosaicInfoSchema);
    }
  }
  if (!info) {
    throw new ToolInputError(
      `Mosaic ${mosaicId} does not exist on ${ctx.network.name} (node ${ctx.rest.host}). Check the id (16 hex characters) or use an alias name such as symbol.xym, and whether you meant mainnet or testnet.`,
    );
  }
  return aliasFromName === undefined ? { mosaicId, info } : { mosaicId, info, aliasFromName };
}
