import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import { AccountInfoSchema, MosaicInfoSchema, MultisigInfoSchema } from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { classifyAccountId, hexAddressToBase32 } from '../domain/address.js';
import { formatAmount } from '../domain/amount.js';
import { parseHeight } from '../domain/epoch.js';
import { defineTool, maskIdentifier, nullable, ToolInputError } from './_shared.js';

export const ACCOUNT_INPUT_HINT =
  'Pass a 39-character base32 address (starts with N on mainnet, T on testnet, e.g. NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY) or a 64-character hex public key. 48-character hex addresses are converted automatically.';

const ZERO_KEY = '0'.repeat(64);

const ACCOUNT_TYPES: Record<number, string> = {
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
      'Account to look up: base32 address (39 chars) or hex public key (64 chars). Hex addresses (48 chars) are also accepted.',
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
    'Multisig settings; null when the account is not a multisig account.',
  ),
});

export const CONCISE_MOSAIC_LIMIT = 10;

/** Shared by account tools: fetches `/accounts/{id}` with a helpful not-found message. */
export async function fetchAccount(ctx: AppContext, account: string) {
  const classified = classifyAccountId(account);
  if (classified.kind === 'invalid') {
    throw new ToolInputError(
      `"${maskIdentifier(account.trim())}" is not a valid Symbol account identifier. ${ACCOUNT_INPUT_HINT}`,
    );
  }
  try {
    const info = await ctx.rest.get(`/accounts/${classified.canonical}`, AccountInfoSchema);
    return { classified, info };
  } catch (err) {
    if (err instanceof RestError && err.kind === 'not_found') {
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
    'Get a Symbol account by address or public key: address in base32 and hex, public key, account type, all mosaic balances (with alias names and divisibility-adjusted amounts), importance, supplemental keys (linked/node/vrf/voting), whether delegated harvesting is configured, and multisig settings if the account is a multisig account.',
  inputSchema,
  outputSchema,
  run: async (ctx, { account, format }) => {
    const [{ info }, { currency }] = await Promise.all([
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
      ctx.rest.getOrNull(`/accounts/${base32}/multisig`, MultisigInfoSchema),
    ]);

    const mosaics = shown.map((m) => {
      const id = m.id.toUpperCase();
      const divisibility = divisibilities.get(id) ?? null;
      return {
        id,
        alias: aliases.get(id) ?? null,
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
    const balanceText = currencyEntry
      ? `${currencyEntry.amount} ${currency.alias ?? currency.mosaicId}`
      : `0 ${currency.alias ?? currency.mosaicId}`;

    const summary = [
      `${base32} on ${ctx.network.name}: ${balanceText}, ${allMosaics.length} mosaic${allMosaics.length === 1 ? '' : 's'}${truncated ? ` (showing ${CONCISE_MOSAIC_LIMIT}; use format=detailed for all)` : ''}.`,
      `Account type ${ACCOUNT_TYPES[acct.accountType] ?? acct.accountType}; delegated harvesting ${delegatedConfigured ? 'configured' : 'not configured'}; ${voting.length} voting key${voting.length === 1 ? '' : 's'}; ${multisig ? `multisig ${multisig.multisig.minApproval}-of-${multisig.multisig.cosignatoryAddresses.length}` : 'not a multisig account'}.`,
    ].join('\n');

    return {
      summary,
      network: ctx.network.name,
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
          ? 'linked and vrf keys are both set; use symbol_harvesting_status to check whether the node has this account unlocked.'
          : 'Delegated harvesting requires both a linked (remote) key and a vrf key.',
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
