/**
 * symbol_holdings_value: what an account's balance of a mosaic (XYM by default) is worth at a
 * unit price the caller supplies.
 *
 * The server has no price source and never contacts one (DESIGN-BRIEF §2-7: traffic goes to
 * SYMBOL_NODE_URL only). The caller obtains the price elsewhere (a web search, another MCP server,
 * the user) and passes it in as a decimal string; this tool reads the balance from the node,
 * multiplies in BigInt (domain/price.ts) and echoes the price and its stated provenance so the
 * answer says where the number came from. Nothing here is an appraisal: no fees, spreads or tax.
 */
import * as z from 'zod/v4';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount, groupThousands } from '../domain/amount.js';
import {
  currencyDecimals,
  multiplyAndRound,
  PriceParseError,
  parseCurrencyCode,
  parseDecimalString,
} from '../domain/price.js';
import { mosaicBalanceOf } from '../domain/rank.js';
import { sanitizeUntrusted } from '../domain/sanitize.js';
import { ACCOUNT_ARG_FORMS, AccountResolutionSchema, withResolutionPrefix } from './_accounts.js';
import { resolveMosaicInput } from './_mosaics.js';
import { defineTool, nullable, ToolInputError } from './_shared.js';
import { fetchAccount } from './symbol_account_get.js';

export const MAX_PRICE_SOURCE_LENGTH = 80;
export const MAX_PRICE_AS_OF_LENGTH = 40;

const inputSchema = z.object({
  account: z.string().min(1).describe(`Account whose holdings to value: ${ACCOUNT_ARG_FORMS}`),
  unitPrice: z
    .string()
    .describe(
      'Price of one whole unit (1 XYM) in `currency`, as a plain decimal STRING such as "12.34", "1200" or "0.0000123" (at most 12 fractional digits). No exponent, thousands separator, currency symbol or sign. The caller supplies this number; the server does not fetch prices.',
    ),
  currency: z
    .string()
    .describe('Currency code of unitPrice: 3 to 6 upper-case letters, e.g. JPY, USD, BTC.'),
  priceSource: z
    .string()
    .max(MAX_PRICE_SOURCE_LENGTH)
    .optional()
    .describe(
      'Where the price came from, e.g. "Zaif XYM/JPY last" (up to 80 characters). Echoed in the output so the answer states its provenance; not verified.',
    ),
  priceAsOf: z
    .string()
    .max(MAX_PRICE_AS_OF_LENGTH)
    .optional()
    .describe('When the price was observed, ISO 8601 (e.g. 2026-09-22T21:00:00+09:00). Echoed.'),
  mosaic: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Mosaic to value: 16-character hex id (e.g. 6BED913FA20223F8) or an alias name such as symbol.xym. Default: the network currency mosaic (XYM).',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): a one-line summary. detailed: the summary also shows the unrounded value. The JSON fields are the same in both.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  address: z.string().describe('Base32 address of the valued account.'),
  accountResolution: AccountResolutionSchema,
  mosaic: z.object({
    id: z.string(),
    alias: nullable(
      z.string(),
      'Namespace alias such as symbol.xym; null when the mosaic has none.',
    ),
    divisibility: z.number(),
  }),
  balance: z.object({
    amount: z.string().describe('Divisibility-adjusted balance of the mosaic.'),
    raw: z.string().describe('Balance as the raw integer string.'),
  }),
  price: z.object({
    unitPrice: z
      .string()
      .describe('The supplied price per whole unit, normalised (no leading or trailing zeros).'),
    currency: z.string(),
    source: nullable(
      z.string(),
      'The priceSource argument as given (untrusted, sanitized); null when omitted.',
    ),
    asOf: nullable(z.string(), 'The priceAsOf argument as given (sanitized); null when omitted.'),
  }),
  value: z.object({
    amount: z
      .string()
      .describe(
        "balance x unitPrice rounded half up to the currency's customary decimals (0 for JPY and KRW, otherwise 2).",
      ),
    exact: z
      .string()
      .describe('balance x unitPrice with every digit (divisibility + price decimals).'),
    currency: z.string(),
  }),
  notes: z.array(z.string()),
});

const FIXED_NOTES: readonly string[] = [
  'The unit price was supplied by the caller; this server does not fetch, check or update prices, and the value is only as good as that input.',
  'The value is the plain product balance x unit price: no exchange fees, spread, slippage or taxes are included.',
  'This is not a tax computation: it is neither an acquisition cost nor a realised gain or loss.',
];

export const holdingsValueTool = defineTool({
  name: 'symbol_holdings_value',
  title: 'Symbol holdings value at a given price',
  description:
    'Value an account\'s balance of a mosaic (XYM by default) at a unit price the CALLER supplies: "at 12.34 JPY per XYM, what are these holdings worth". This tool only multiplies; it never fetches or checks prices. Obtain the price first (a web search, another price MCP server, or the user) and pass it as a decimal string with its currency code, optionally with where and when it was observed (priceSource, priceAsOf) so the answer states its provenance. Returns the balance, the normalised price, the exact product and the product rounded to the currency\'s customary decimals (0 for JPY and KRW, otherwise 2), all computed in integer arithmetic.',
  inputSchema,
  outputSchema,
  run: async (ctx, { account, unitPrice, currency, priceSource, priceAsOf, mosaic, format }) => {
    // Inputs the caller can get wrong are checked before any request, with a hint each.
    let price: ReturnType<typeof parseDecimalString>;
    let currencyCode: string;
    try {
      price = parseDecimalString(unitPrice);
      currencyCode = parseCurrencyCode(currency);
    } catch (err) {
      if (err instanceof PriceParseError) throw new ToolInputError(err.message);
      throw err;
    }
    // Provenance strings are untrusted text: strip control characters before validating / echoing.
    const source =
      priceSource === undefined ? null : sanitizeUntrusted(priceSource, MAX_PRICE_SOURCE_LENGTH);
    const asOf =
      priceAsOf === undefined ? null : sanitizeUntrusted(priceAsOf, MAX_PRICE_AS_OF_LENGTH);
    if (asOf !== null && Number.isNaN(Date.parse(asOf))) {
      throw new ToolInputError(
        `priceAsOf "${asOf}" is not a date. Pass an ISO 8601 timestamp such as 2026-09-22T21:00:00+09:00, or omit it.`,
      );
    }

    const { currency: networkCurrency } = await ctx.getNetworkData();

    // Mosaic: the network currency (no extra request) or the given id / alias name.
    let mosaicId: string;
    let divisibility: number;
    let alias: string | null;
    if (mosaic === undefined) {
      mosaicId = networkCurrency.mosaicId;
      divisibility = networkCurrency.divisibility;
      alias = networkCurrency.alias;
    } else {
      const resolved = await resolveMosaicInput(ctx, mosaic);
      mosaicId = resolved.mosaicId;
      divisibility = resolved.info.mosaic.divisibility;
      if (mosaicId === networkCurrency.mosaicId) {
        alias = networkCurrency.alias ?? resolved.aliasFromName ?? null;
      } else {
        const aliases = await ctx.resolveMosaicAliases([mosaicId]);
        alias = aliases.get(mosaicId) ?? resolved.aliasFromName ?? null;
      }
    }
    const isNetworkCurrency = mosaicId === networkCurrency.mosaicId;
    const label = alias ?? mosaicId;
    const unitLabel = isNetworkCurrency ? 'XYM' : label;

    const { info, resolution } = await fetchAccount(ctx, account);
    const address = hexAddressToBase32(info.account.address);
    const balanceRaw = mosaicBalanceOf(info.account.mosaics, mosaicId);
    const balance = formatAmount(balanceRaw, divisibility);

    const decimals = currencyDecimals(currencyCode);
    const value = multiplyAndRound(balanceRaw, divisibility, price, decimals);

    const provenance = ['price supplied by the caller'];
    if (source !== null) provenance.push(`: ${source}`);
    if (asOf !== null) provenance.push(`, as of ${asOf}`);
    const lines = [
      `${address} holds ${groupThousands(balance)} ${label}; at ${price.normalized} ${currencyCode} per ${unitLabel} that is ${groupThousands(value.amount)} ${currencyCode} (${provenance.join('')}).`,
    ];
    if (format === 'detailed') {
      lines.push(`Unrounded: ${groupThousands(value.exact)} ${currencyCode}.`);
    }
    const summary = withResolutionPrefix(lines.join('\n'), resolution);

    return {
      summary,
      network: ctx.network.name,
      address,
      accountResolution: resolution,
      mosaic: { id: mosaicId, alias, divisibility },
      balance: { amount: balance, raw: balanceRaw.toString() },
      price: { unitPrice: price.normalized, currency: currencyCode, source, asOf },
      value: { amount: value.amount, exact: value.exact, currency: currencyCode },
      notes: [...FIXED_NOTES],
    };
  },
});
