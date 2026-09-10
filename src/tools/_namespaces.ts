/**
 * Shared namespace/mosaic lookup helpers for symbol_mosaic_get and symbol_namespace_get.
 */
import { type NamespaceInfo, NamespaceInfoSchema } from '../client/schemas.js';
import type { AppContext } from '../context.js';
import {
  isHexNamespaceId,
  isValidNamespacePath,
  namespaceNameToHexId,
} from '../domain/namespace.js';
import { ToolInputError } from './_shared.js';

export const NAMESPACE_INPUT_HINT =
  'Pass a namespace name such as symbol.xym (lower-case letters, digits, - and _, up to 3 dot-separated levels) or its 16-character hex id such as E74B99BA41F4AFEE.';

export interface ResolvedNamespaceId {
  readonly id: string;
  /** How the id was obtained: given as hex, or derived from a name. */
  readonly source: 'hex' | 'name';
  readonly name?: string;
}

/** Turns user input (name or hex id) into an upper-case namespace id without contacting the node. */
export function resolveNamespaceInput(value: string): ResolvedNamespaceId {
  const trimmed = value.trim();
  if (isHexNamespaceId(trimmed)) return { id: trimmed.toUpperCase(), source: 'hex' };
  const name = trimmed.toLowerCase();
  if (isValidNamespacePath(name)) return { id: namespaceNameToHexId(name), source: 'name', name };
  throw new ToolInputError(
    `"${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}" is not a namespace name or id. ${NAMESPACE_INPUT_HINT}`,
  );
}

/** Fetches a namespace or throws a hinted not-found error. */
export async function fetchNamespace(
  ctx: AppContext,
  resolved: ResolvedNamespaceId,
): Promise<NamespaceInfo> {
  const info = await ctx.rest.getOrNull(`/namespaces/${resolved.id}`, NamespaceInfoSchema);
  if (!info) {
    const shown = resolved.name ? `"${resolved.name}" (id ${resolved.id})` : `id ${resolved.id}`;
    throw new ToolInputError(
      `Namespace ${shown} does not exist on ${ctx.network.name} (node ${ctx.rest.host}). It may be expired and pruned, never registered, or on the other network. ${NAMESPACE_INPUT_HINT}`,
    );
  }
  return info;
}

/** Ids of every level of a namespace, root first. */
export function namespaceLevels(info: NamespaceInfo): string[] {
  const ns = info.namespace;
  return [ns.level0, ns.level1, ns.level2]
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.toUpperCase());
}
