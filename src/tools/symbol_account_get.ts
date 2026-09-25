import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import {
  type AccountInfo,
  AccountInfoSchema,
  MosaicInfoSchema,
  type MultisigInfo,
  MultisigInfoSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount } from '../domain/amount.js';
import { parseHeight } from '../domain/epoch.js';
import {
  type AccountResolution,
  AccountResolutionSchema,
  resolveAccountInput,
  withResolutionPrefix,
} from './_accounts.js';
import { defineTool, maskIdentifier, nullable, ToolInputError } from './_shared.js';

export { ACCOUNT_INPUT_HINT } from './_accounts.js';

const ZERO_KEY = '0'.repeat(64);

/**
 * symbol-openapi AccountTypeEnum: 0 unlinked, 1 balance-holding account linked to a remote
 * harvester, 2 remote harvester linked to a balance-holding account, 3 remote-harvester-eligible
 * account that is unlinked.
 */
export const ACCOUNT_TYPES: Record<number, string> = {
  0: 'Unlinked',
  1: 'Main',
  2: 'Remote',
  3: 'Remote_Unlinked',
};

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe(
      'Account to look up: base32 address (39 chars), hex public key (64 chars), or a namespace name with an address alias (e.g. alice, alice.pay; resolved through the node). Hex addresses (48 chars) are also accepted.',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): at most 10 mosaics and the essential fields. detailed: every mosaic plus address/public-key heights.',
    ),
});

const MosaicSchema = z.object({
  id: z.string(),
  alias: nullable(z.string(), 'Namespace alias such as symbol.xym; null when the mosaic has none.'),
  amount: z.string(),
  rawAmount: z.string(),
  divisibility: nullable(
    z.number(),
    'Decimal places applied to amount; null when the mosaic definition could not be fetched.',
  ),
});

const VotingKeySchema = z.object({
  publicKey: z.string(),
  startEpoch: z.number(),
  endEpoch: z.number(),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  accountResolution: AccountResolutionSchema,
  address: z.object({ base32: z.string(), hex: z.string() }),
  publicKey: nullable(
    z.string(),
    'Hex public key; null until the account has sent its first transaction.',
  ),
  accountType: z.object({ code: z.number(), name: z.string() }),
  heights: z.object({ addressHeight: z.number(), publicKeyHeight: z.number() }).optional(),
  mosaics: z.array(MosaicSchema),
  mosaicCount: z.number(),
  truncated: z.boolean(),
  importance: z.object({ raw: z.string(), height: z.number() }),
  supplementalPublicKeys: z.object({
    linked: nullable(z.string(), 'Linked (remote harvesting) public key; null when not set.'),
    node: nullable(z.string(), 'Node public key; null when not set.'),
    vrf: nullable(z.string(), 'VRF public key; null when not set.'),
    voting: z.array(VotingKeySchema),
  }),
  delegatedHarvesting: z.object({ configured: z.boolean(), note: z.string() }),
  multisig: nullable(
    z.object({
      minApproval: z.number(),
      minRemoval: z.number(),
      cosignatoryAddresses: z.array(z.string()),
      multisigAddresses: z.array(z.string()),
    }),
    'Multisig entry of the account. A multisig account lists its cosignatoryAddresses with minApproval/minRemoval; a cosignatory lists the multisigAddresses it cosigns for (minApproval and minRemoval are then 0); an account can be both. null when the account is neither.',
  ),
});

export const CONCISE_MOSAIC_LIMIT = 10;

/**
 * Shared by account tools: resolves the argument (address, public key or namespace name, see
 * _accounts.ts) and fetches `/accounts/{id}` with a helpful not-found message. `resolution` is
 * non-null only when a namespace name was resolved; tools put it in `accountResolution`.
 */
export async function fetchAccount(
  ctx: AppContext,
  account: string,
): Promise<{
  classified: Awaited<ReturnType<typeof resolveAccountInput>>['classified'];
  info: AccountInfo;
  resolution: AccountResolution | null;
}> {
  const { classified, resolution } = await resolveAccountInput(ctx, account);
  try {
    const info = await ctx.rest.get(`/accounts/${classified.canonical}`, AccountInfoSchema);
    return { classified, info, resolution };
  } catch (err) {
    if (err instanceof RestError && err.kind === 'not_found') {
      if (resolution) {
        throw new ToolInputError(
          `Namespace "${resolution.namespace}" aliases ${resolution.address}, but no account with that address exists on ${ctx.network.name} (node ${ctx.rest.host}). Accounts appear on-chain only after their first transaction; the alias may point at an unused address.`,
        );
      }
      const shown =
        classified.kind === 'publicKey'
          ? `public key ${maskIdentifier(classified.canonical)}`
          : `address ${classified.canonical}`;
      throw new ToolInputError(
        `No account with ${shown} exists on ${ctx.network.name} (node ${ctx.rest.host}). Accounts appear on-chain only after their first transaction. Check the identifier and whether you meant mainnet or testnet.`,
      );
    }
    throw err;
  }
}

export const accountGetTool = defineTool({
  name: 'symbol_account_get',
  title: 'Symbol account details',
  description:
    'Get what a Symbol account holds and how it is set up, by address, public key or namespace name (alice, alice.pay; resolved to its address alias and reported in accountResolution): balances, importance, keys and multisig settings. For whether its delegated harvesting actually works, use symbol_delegation_diagnose; for its harvesting rewards, symbol_harvesting_income. Returns the address in base32 and hex, public key, account type, all mosaic balances (with alias names and divisibility-adjusted amounts), importance, supplemental keys (linked/node/vrf/voting), whether delegated harvesting is configured (the linked and VRF keys are both registered; whether a node has unlocked the key is not checked), and multisig settings if the account is a multisig account or a cosignatory of one.',
  inputSchema,
  outputSchema,
  untrustedText: true,
  run: async (ctx, { account, format }, text) => {
    const [{ info, resolution }, { currency }] = await Promise.all([
      fetchAccount(ctx, account),
      ctx.getNetworkData(),
    ]);
    const acct = info.account;
    const base32 = hexAddressToBase32(acct.address);

    const allMosaics = acct.mosaics;
    const truncated = format === 'concise' && allMosaics.length > CONCISE_MOSAIC_LIMIT;
    const shown = truncated ? allMosaics.slice(0, CONCISE_MOSAIC_LIMIT) : allMosaics;
    const ids = shown.map((m) => m.id.toUpperCase());

    const [aliases, divisibilities, multisig] = await Promise.all([
      ctx.resolveMosaicAliases(ids),
      resolveDivisibilities(ctx, ids, currency),
      ctx.rest.getOrNull(`/account/${base32}/multisig`, MultisigInfoSchema),
    ]);

    const mosaics = shown.map((m) => {
      const id = m.id.toUpperCase();
      const divisibility = divisibilities.get(id) ?? null;
      return {
        id,
        alias: text.useOrNull(aliases.get(id)),
        amount: divisibility === null ? m.amount : formatAmount(m.amount, divisibility),
        rawAmount: m.amount,
        divisibility,
      };
    });

    const publicKey =
      acct.publicKey.toUpperCase() === ZERO_KEY ? null : acct.publicKey.toUpperCase();
    const linked = acct.supplementalPublicKeys.linked?.publicKey ?? null;
    const vrf = acct.supplementalPublicKeys.vrf?.publicKey ?? null;
    const node = acct.supplementalPublicKeys.node?.publicKey ?? null;
    const voting = acct.supplementalPublicKeys.voting?.publicKeys ?? [];
    const delegatedConfigured = linked !== null && vrf !== null;

    const currencyEntry = mosaics.find((m) => m.id === currency.mosaicId);
    // The alias of a listed currency entry is already counted; otherwise use the cached one.
    const currencyLabel =
      currencyEntry?.alias ?? text.useOrNull(currency.alias) ?? currency.mosaicId;
    const balanceText = `${currencyEntry ? currencyEntry.amount : '0'} ${currencyLabel}`;

    const summary = [
      `${base32} on ${ctx.network.name}: ${balanceText}, ${allMosaics.length} mosaic${allMosaics.length === 1 ? '' : 's'}${truncated ? ` (showing ${CONCISE_MOSAIC_LIMIT}; use format=detailed for all)` : ''}.`,
      `Account type ${ACCOUNT_TYPES[acct.accountType] ?? acct.accountType}; delegated harvesting ${delegatedConfigured ? 'configured' : 'not configured'}; ${voting.length} voting key${voting.length === 1 ? '' : 's'}; ${describeMultisig(multisig)}.`,
    ].join('\n');

    return {
      summary: withResolutionPrefix(summary, resolution),
      network: ctx.network.name,
      accountResolution: resolution,
      address: { base32, hex: acct.address.toUpperCase() },
      publicKey,
      accountType: {
        code: acct.accountType,
        name: ACCOUNT_TYPES[acct.accountType] ?? 'Unknown',
      },
      ...(format === 'detailed'
        ? {
            heights: {
              addressHeight: parseHeight(acct.addressHeight),
              publicKeyHeight: parseHeight(acct.publicKeyHeight),
            },
          }
        : {}),
      mosaics,
      mosaicCount: allMosaics.length,
      truncated,
      importance: { raw: acct.importance, height: parseHeight(acct.importanceHeight) },
      supplementalPublicKeys: {
        linked,
        node,
        vrf,
        voting: voting.map((k) => ({
          publicKey: k.publicKey.toUpperCase(),
          startEpoch: k.startEpoch,
          endEpoch: k.endEpoch,
        })),
      },
      delegatedHarvesting: {
        configured: delegatedConfigured,
        note: delegatedConfigured
          ? 'The linked and VRF keys are both set. Whether delegated harvesting actually works (node key, the unlocked list of the node, balance limits, importance, recent blocks) is checked by symbol_delegation_diagnose.'
          : 'Delegated harvesting needs both a linked (remote) key and a VRF key; symbol_delegation_diagnose shows which step is missing.',
      },
      multisig: multisig
        ? {
            minApproval: multisig.multisig.minApproval,
            minRemoval: multisig.multisig.minRemoval,
            cosignatoryAddresses: multisig.multisig.cosignatoryAddresses.map(hexAddressToBase32),
            multisigAddresses: multisig.multisig.multisigAddresses.map(hexAddressToBase32),
          }
        : null,
    };
  },
});

/**
 * catapult keeps a multisig entry for both sides of the link: the multisig account lists its
 * cosignatories (and minApproval/minRemoval), each cosignatory lists the multisig accounts it
 * cosigns for (with minApproval/minRemoval 0). An account can be both in a multilevel multisig.
 */
function describeMultisig(entry: MultisigInfo | null): string {
  const cosignatories = entry?.multisig.cosignatoryAddresses.length ?? 0;
  const cosignsFor = entry?.multisig.multisigAddresses.length ?? 0;
  const parts: string[] = [];
  if (entry && cosignatories > 0) {
    parts.push(`multisig ${entry.multisig.minApproval}-of-${cosignatories}`);
  }
  if (cosignsFor > 0) {
    parts.push(
      `cosignatory of ${cosignsFor} multisig account${cosignsFor === 1 ? '' : 's'}${cosignatories > 0 ? '' : ' (not a multisig account itself)'}`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : 'not a multisig account';
}

async function resolveDivisibilities(
  ctx: AppContext,
  ids: readonly string[],
  currency: { mosaicId: string; divisibility: number },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    ids.map(async (id) => {
      if (id === currency.mosaicId) {
        out.set(id, currency.divisibility);
        return;
      }
      const info = await ctx.rest.getOrNull(`/mosaics/${id}`, MosaicInfoSchema);
      if (info) out.set(id, info.mosaic.divisibility);
    }),
  );
  return out;
}
