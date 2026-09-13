/**
 * Account arguments: base32 address, hex address, hex public key, or a namespace name that
 * carries an address alias (`alice`, `alice.pay`). Every tool that takes an account goes through
 * `resolveAccountInput`, so the accepted forms, the error hints and the `accountResolution`
 * output field are the same everywhere.
 *
 * Resolution rule (DESIGN-BRIEF §5 common conventions): classify (domain/address.ts) → for a
 * namespace, derive the id (domain/namespace.ts, same SHA3 path as symbol_namespace_get) →
 * `GET /namespaces/{id}` through the per-process short-TTL cache → the namespace must exist, be
 * active and carry an address alias (AliasTypeEnum 2); anything else is a ToolInputError with a
 * specific hint. Reverse lookup (address → names) is out of scope.
 */
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import {
  type ClassifiedAccountId,
  classifyAccountId,
  hexAddressToBase32,
} from '../domain/address.js';
import { namespaceNameToHexId } from '../domain/namespace.js';
import { sanitizeUntrusted } from '../domain/sanitize.js';
import { maskIdentifier, nullable, ToolInputError } from './_shared.js';

export const ACCOUNT_INPUT_HINT =
  'Pass a 39-character base32 address (starts with N on mainnet, T on testnet, e.g. NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY), a 64-character hex public key, or a namespace name such as alice or alice.pay that has an address alias. 48-character hex addresses are converted automatically.';

/** Appended to every account argument description. */
export const ACCOUNT_ARG_FORMS =
  'base32 address (39 chars), hex public key (64 chars), or a namespace name with an address alias (e.g. alice, alice.pay; resolved through the node). Hex addresses (48 chars) are also accepted.';

/** AliasTypeEnum (symbol-openapi spec/plugins/namespace/schemas/AliasTypeEnum.yml). */
const ALIAS_NONE = 0;
const ALIAS_MOSAIC = 1;
const ALIAS_ADDRESS = 2;

export interface AccountResolution {
  /** The argument as given (untrusted, sanitized). */
  readonly input: string;
  /** Dotted namespace name (untrusted, sanitized). */
  readonly namespace: string;
  readonly namespaceId: string;
  /** Base32 address the namespace aliases. */
  readonly address: string;
}

export const AccountResolutionSchema = nullable(
  z.object({
    input: z.string(),
    namespace: z.string().describe('Namespace name that was resolved (untrusted, sanitized).'),
    namespaceId: z.string(),
    address: z.string().describe('Base32 address the namespace aliases.'),
  }),
  'How a namespace-name argument was resolved to an address; null when the account was given as an address or public key.',
);

export interface ResolvedAccountInput {
  /** Never of kind 'namespace': a name has already been turned into its aliased address. */
  readonly classified: ClassifiedAccountId;
  readonly resolution: AccountResolution | null;
}

/**
 * Turns an account argument into an address or public key, resolving namespace names through
 * the node. Throws ToolInputError with a hint for invalid input or an unusable namespace.
 */
export async function resolveAccountInput(
  ctx: AppContext,
  value: string,
): Promise<ResolvedAccountInput> {
  const classified = classifyAccountId(value);
  if (classified.kind === 'invalid') {
    throw new ToolInputError(
      `"${maskIdentifier(value.trim())}" is not a valid Symbol account identifier. ${ACCOUNT_INPUT_HINT}`,
    );
  }
  if (classified.kind !== 'namespace') return { classified, resolution: null };

  const name = classified.canonical;
  const namespaceId = namespaceNameToHexId(name);
  const shown = `"${sanitizeUntrusted(name, 64)}" (${namespaceId})`;
  const info = await ctx.getNamespaceInfo(namespaceId);
  if (info === null) {
    throw new ToolInputError(
      `Namespace ${shown} does not exist on ${ctx.network.name} (node ${ctx.rest.host}): never registered, or expired and pruned. Check the spelling, or pass the address directly. ${ACCOUNT_INPUT_HINT}`,
    );
  }
  if (info.meta.active === false) {
    throw new ToolInputError(
      `Namespace ${shown} has expired on ${ctx.network.name}; its alias no longer resolves. Pass the address directly, or ask the owner to renew the namespace.`,
    );
  }
  const alias = info.namespace.alias;
  if (alias.type === ALIAS_MOSAIC) {
    throw new ToolInputError(
      `Namespace ${shown} is a mosaic alias${alias.mosaicId ? ` for ${alias.mosaicId.toUpperCase()}` : ''}, not an address. Use symbol_mosaic_get for the mosaic, or pass an address for the account.`,
    );
  }
  if (alias.type !== ALIAS_ADDRESS || !alias.address) {
    const reason =
      alias.type === ALIAS_NONE ? 'has no alias' : `has an unknown alias type ${alias.type}`;
    throw new ToolInputError(
      `Namespace ${shown} ${reason}, so it does not name an account. The owner can link it with an AddressAlias transaction; until then pass the address directly.`,
    );
  }
  const address = hexAddressToBase32(alias.address);
  return {
    classified: { kind: 'address', canonical: address },
    resolution: {
      input: sanitizeUntrusted(value.trim(), 64),
      namespace: sanitizeUntrusted(name, 64),
      namespaceId,
      address,
    },
  };
}

/** Puts "alice → NCV5…" in front of the first summary line when a name was resolved. */
export function withResolutionPrefix(
  summary: string,
  resolution: AccountResolution | null,
): string {
  if (!resolution) return summary;
  return `${resolution.namespace} → ${resolution.address}. ${summary}`;
}
