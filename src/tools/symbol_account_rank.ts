/**
 * symbol_account_rank: where an account stands among the holders of a mosaic (XYM by default)
 * and who the top holders are, like an explorer rich list.
 *
 * Data source (symbol-openapi v1.0.4, checked 2026-09-22): `GET /accounts?mosaicId=&orderBy=balance`
 * (AccountOrderByEnum is `id | balance`; `balance` requires the `mosaicId` filter; pageSize max
 * 100). Pages are read one at a time, in order, until the account is found, the holder list ends,
 * or ceil(maxRank / 100) pages were read. Supply comes from `GET /mosaics/{id}`. All amounts and
 * shares are BigInt arithmetic; nothing is estimated.
 */
import * as z from 'zod/v4';
import { AccountPageSchema, MosaicInfoSchema } from '../client/schemas.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount, groupThousands } from '../domain/amount.js';
import {
  HOLDER_PAGE_SIZE,
  mosaicBalanceOf,
  pagesToScan,
  percentOfSupply,
  rankOf,
} from '../domain/rank.js';
import { ACCOUNT_ARG_FORMS, AccountResolutionSchema, withResolutionPrefix } from './_accounts.js';
import { resolveMosaicInput } from './_mosaics.js';
import { defineTool, formatInteger, nullable } from './_shared.js';
import { fetchAccount } from './symbol_account_get.js';

export const MIN_TOP = 1;
export const MAX_TOP = 100;
export const MIN_MAX_RANK = 100;
export const MAX_MAX_RANK = 5000;

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Account whose rank to find: ${ACCOUNT_ARG_FORMS} Omit to list the top holders only.`,
    ),
  mosaic: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Mosaic to rank by: 16-character hex id (e.g. 6BED913FA20223F8) or an alias name such as symbol.xym. Default: the network currency mosaic (XYM).',
    ),
  top: z
    .number()
    .int()
    .min(MIN_TOP)
    .max(MAX_TOP)
    .default(20)
    .describe('How many top holders to list (1 to 100; default 20).'),
  maxRank: z
    .number()
    .int()
    .min(MIN_MAX_RANK)
    .max(MAX_MAX_RANK)
    .default(1000)
    .describe(
      'How far down the holder list to look for the account (100 to 5000; default 1000 = up to 10 requests of 100 holders). The scan stops as soon as the account is found.',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): a short summary. detailed: the summary also lists every top holder on its own line. The JSON fields are the same in both.',
    ),
});

const SHARE_DESCRIPTION =
  'Share of the mosaic supply in percent with 4 decimals (BigInt arithmetic, rounded half up); null when the supply is 0.';

const HolderSchema = z.object({
  rank: z.number().describe('1 = largest holder.'),
  address: z.string().describe('Base32 address (public chain data, unlabelled).'),
  balance: z.string().describe('Divisibility-adjusted balance.'),
  balanceRaw: z.string().describe('Balance as the raw integer string.'),
  sharePercent: nullable(z.string(), SHARE_DESCRIPTION),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  accountResolution: AccountResolutionSchema,
  mosaic: z.object({
    id: z.string(),
    alias: nullable(
      z.string(),
      'Namespace alias such as symbol.xym; null when the mosaic has none.',
    ),
    divisibility: z.number(),
    supply: z.string().describe('Divisibility-adjusted total supply.'),
    supplyRaw: z.string().describe('Total supply as the raw integer string.'),
  }),
  account: nullable(
    z.object({
      address: z.string(),
      rank: nullable(
        z.number(),
        'Position in the holder list ordered by balance (1 = largest); null when the account was not found within maxRank or holds none of the mosaic.',
      ),
      rankBeyond: nullable(
        z.number(),
        'Set when rank is null because the scan stopped at maxRank: the account ranks below this number. Null when the rank was found, when the holder list ended first, or when the account holds none of the mosaic.',
      ),
      balance: z.string().describe('Divisibility-adjusted balance from GET /accounts/{address}.'),
      balanceRaw: z.string(),
      sharePercent: nullable(z.string(), SHARE_DESCRIPTION),
    }),
    'Balance and rank of the requested account; null when no account was given.',
  ),
  topHolders: z.array(HolderSchema).describe('The top holders, rank ascending.'),
  topHoldersSharePercent: nullable(
    z.string(),
    'Combined share of supply held by the listed top holders (4 decimals); null when the supply is 0.',
  ),
  fetch: z.object({
    pagesFetched: z.number().describe('GET /accounts requests made (100 holders each).'),
    accountsScanned: z.number().describe('Holder rows read across those pages.'),
  }),
  notes: z.array(z.string()),
});

const FIXED_NOTES: readonly string[] = [
  'Top holders are often exchange hot wallets, custodians or foundation accounts; the tool attaches no labels and cannot tell who controls an address.',
  'Rank is by balance of this mosaic as ordered by the node (GET /accounts orderBy=balance), not by importance; catapult-rest offers no importance ordering.',
  'Accounts with equal balances are ordered by the node and may swap places between calls.',
  "Addresses are public chain data, but consider the purpose before pasting someone else's address elsewhere.",
];

export const accountRankTool = defineTool({
  name: 'symbol_account_rank',
  title: 'Symbol holder rank and rich list',
  description:
    "Rank an account by its holdings of a mosaic (XYM by default) and list the top holders, like an explorer rich list: the account's balance, share of supply and rank (holders are scanned 100 per request, down to maxRank), the top N holders with balances and shares, and the combined share of the top N. Omit account to get the top list only. The node orders holders by balance (ties are node-dependent); no labels such as exchange or foundation are attached.",
  inputSchema,
  outputSchema,
  run: async (ctx, { account, mosaic, top, maxRank, format }) => {
    const { currency } = await ctx.getNetworkData();

    // Mosaic: default currency, or the given id / alias name.
    let mosaicId: string;
    let divisibility: number;
    let supplyRaw: bigint;
    let alias: string | null;
    if (mosaic === undefined) {
      mosaicId = currency.mosaicId;
      const info = await ctx.rest.get(`/mosaics/${mosaicId}`, MosaicInfoSchema);
      divisibility = info.mosaic.divisibility;
      supplyRaw = BigInt(info.mosaic.supply);
      alias = currency.alias;
    } else {
      const resolved = await resolveMosaicInput(ctx, mosaic);
      mosaicId = resolved.mosaicId;
      divisibility = resolved.info.mosaic.divisibility;
      supplyRaw = BigInt(resolved.info.mosaic.supply);
      if (mosaicId === currency.mosaicId) {
        alias = currency.alias ?? resolved.aliasFromName ?? null;
      } else {
        const aliases = await ctx.resolveMosaicAliases([mosaicId]);
        alias = aliases.get(mosaicId) ?? resolved.aliasFromName ?? null;
      }
    }
    const label = alias ?? mosaicId;
    const fmt = (raw: bigint) => formatAmount(raw, divisibility);

    // Account: balance from /accounts/{id}; the rank comes from the scan below.
    let target: {
      address: string;
      hex: string;
      resolution: Awaited<ReturnType<typeof fetchAccount>>['resolution'];
      balanceRaw: bigint;
    } | null = null;
    if (account !== undefined) {
      const { info, resolution } = await fetchAccount(ctx, account);
      target = {
        address: hexAddressToBase32(info.account.address),
        hex: info.account.address.toUpperCase(),
        resolution,
        balanceRaw: mosaicBalanceOf(info.account.mosaics, mosaicId),
      };
    }

    // Scan: one page at a time, ascending, until found / list ended / page limit.
    const pageLimit = pagesToScan(maxRank, HOLDER_PAGE_SIZE);
    const topHolders: z.output<typeof HolderSchema>[] = [];
    let topSum = 0n;
    let rank: number | null = null;
    let pagesFetched = 0;
    let accountsScanned = 0;
    let listEnded = false;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      const params = new URLSearchParams({
        mosaicId,
        orderBy: 'balance',
        order: 'desc',
        pageSize: String(HOLDER_PAGE_SIZE),
        pageNumber: String(pageNumber),
      });
      const page = await ctx.rest.get(`/accounts?${params.toString()}`, AccountPageSchema);
      pagesFetched++;
      accountsScanned += page.data.length;
      page.data.forEach((row, index) => {
        const r = rankOf(pageNumber, HOLDER_PAGE_SIZE, index);
        const balance = mosaicBalanceOf(row.account.mosaics, mosaicId);
        if (r <= top) {
          topHolders.push({
            rank: r,
            address: hexAddressToBase32(row.account.address),
            balance: fmt(balance),
            balanceRaw: balance.toString(),
            sharePercent: percentOfSupply(balance, supplyRaw),
          });
          topSum += balance;
        }
        if (target && rank === null && row.account.address.toUpperCase() === target.hex) {
          rank = r;
        }
      });
      if (page.data.length < HOLDER_PAGE_SIZE) {
        listEnded = true;
        break;
      }
      if (!target || rank !== null || target.balanceRaw === 0n) break;
    }
    const hitPageLimit = target !== null && rank === null && !listEnded && target.balanceRaw > 0n;
    const rankBeyond = hitPageLimit ? maxRank : null;
    const topShare = percentOfSupply(topSum, supplyRaw);

    // Summary and notes.
    const lines: string[] = [];
    if (target) {
      const share = percentOfSupply(target.balanceRaw, supplyRaw);
      const holding = `${target.address} holds ${groupThousands(fmt(target.balanceRaw))} ${label}${share === null ? '' : ` (${share}% of supply)`}`;
      if (rank !== null) {
        lines.push(`${holding}, rank ${formatInteger(rank)} by ${label} balance.`);
      } else if (target.balanceRaw === 0n) {
        lines.push(`${holding}, so it has no rank among ${label} holders.`);
      } else if (hitPageLimit) {
        lines.push(
          `${holding} but is not within the top ${formatInteger(maxRank)} holders; raise maxRank (up to ${formatInteger(MAX_MAX_RANK)}) to look further.`,
        );
      } else {
        lines.push(
          `${holding} but did not appear among the ${formatInteger(accountsScanned)} holders the node listed for ${label}.`,
        );
      }
    }
    const shown = topHolders.length;
    lines.push(
      `Top ${formatInteger(shown)} ${label} holders own ${topShare === null ? 'an unknown share' : `${topShare}%`} of supply (${groupThousands(fmt(supplyRaw))} ${label} in circulation).`,
    );
    if (format === 'detailed') {
      for (const h of topHolders) {
        lines.push(
          `#${h.rank} ${h.address}: ${groupThousands(h.balance)} ${label}${h.sharePercent === null ? '' : ` (${h.sharePercent}%)`}`,
        );
      }
    }
    const summary = withResolutionPrefix(lines.join('\n'), target?.resolution ?? null);

    const notes = [...FIXED_NOTES];
    if (target) {
      notes.push(
        'The account balance comes from GET /accounts/{address}; the rank comes from the paged holder list, which the node may have indexed a few blocks apart.',
      );
    }
    if (hitPageLimit) {
      notes.push(
        `The scan stopped at maxRank ${formatInteger(maxRank)} (${formatInteger(pagesFetched)} requests of ${HOLDER_PAGE_SIZE} holders); the account ranks below that.`,
      );
    }
    if (listEnded) {
      notes.push(`The node listed ${formatInteger(accountsScanned)} holders of ${label} in total.`);
    }

    return {
      summary,
      network: ctx.network.name,
      accountResolution: target?.resolution ?? null,
      mosaic: {
        id: mosaicId,
        alias,
        divisibility,
        supply: fmt(supplyRaw),
        supplyRaw: supplyRaw.toString(),
      },
      account: target
        ? {
            address: target.address,
            rank,
            rankBeyond,
            balance: fmt(target.balanceRaw),
            balanceRaw: target.balanceRaw.toString(),
            sharePercent: percentOfSupply(target.balanceRaw, supplyRaw),
          }
        : null,
      topHolders,
      topHoldersSharePercent: topShare,
      fetch: { pagesFetched, accountsScanned },
      notes,
    };
  },
});
