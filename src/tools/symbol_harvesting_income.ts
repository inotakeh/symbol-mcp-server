import * as z from 'zod/v4';
import {
  BlockInfoSchema,
  ChainInfoSchema,
  type TransactionStatementInfo,
  TransactionStatementPageSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount } from '../domain/amount.js';
import { parseHeight } from '../domain/epoch.js';
import {
  aggregateHarvestIncome,
  type BlockTimestampLookup,
  firstHeightAtOrAfter,
  type HarvestTotals,
  lastHeightAtOrBefore,
} from '../domain/harvesting.js';
import {
  type CalendarDate,
  compareCalendarDates,
  dayEnd,
  dayStart,
  formatCalendarDate,
  parseCalendarDate,
} from '../domain/localdate.js';
import { receiptTypeCode } from '../domain/receipttype.js';
import {
  dateToNetworkTimestamp,
  formatInstantText,
  networkTimestampToDate,
} from '../domain/time.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';
import { fetchAccount } from './symbol_account_get.js';

/** catapult-rest caps statement pages at 100 entries. */
export const STATEMENT_PAGE_SIZE = 100;
/** Hard stop: 200 pages = 20,000 statements per call. */
export const MAX_STATEMENT_PAGES = 200;
export const CONCISE_RECEIPT_LIMIT = 50;
export const DETAILED_RECEIPT_LIMIT = 500;
const SUMMARY_DAYS = 7;

const PERIOD_HINT =
  'Give the period either as fromDate and toDate (YYYY-MM-DD, both inclusive, in SYMBOL_TIMEZONE or UTC) or as fromHeight and toHeight (block heights, both inclusive), never both.';

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe(
      'Account whose harvest income to total: base32 address (39 chars) or hex public key (64 chars). Hex addresses (48 chars) are also accepted.',
    ),
  fromDate: z
    .string()
    .optional()
    .describe(
      'First calendar day of the period, YYYY-MM-DD (inclusive), interpreted in SYMBOL_TIMEZONE or UTC when it is not set. Requires toDate; do not combine with fromHeight/toHeight.',
    ),
  toDate: z
    .string()
    .optional()
    .describe(
      'Last calendar day of the period, YYYY-MM-DD (inclusive, up to 23:59:59.999 local). Requires fromDate.',
    ),
  fromHeight: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'First block height of the period (inclusive). Requires toHeight; do not combine with fromDate/toDate.',
    ),
  toHeight: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Last block height of the period (inclusive; capped at the current height). Requires fromHeight.',
    ),
  granularity: z
    .enum(['daily', 'receipt'])
    .default('daily')
    .describe(
      'daily (default): one row per calendar day with receipts. receipt: one row per receipt (block, time, kind, amount).',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      `Only affects granularity=receipt: concise lists at most ${CONCISE_RECEIPT_LIMIT} receipts, detailed at most ${DETAILED_RECEIPT_LIMIT}. Totals always cover the whole period.`,
    ),
});

const TotalsSchema = z.object({
  receipts: z.number(),
  xym: z.string(),
  raw: z.string(),
  receiptsHarvester: z.number(),
  xymHarvester: z.string(),
  rawHarvester: z.string(),
  receiptsBeneficiary: z.number(),
  xymBeneficiary: z.string(),
  rawBeneficiary: z.string(),
  receiptsUnknown: z.number(),
  xymUnknown: z.string(),
  rawUnknown: z.string(),
});

const DailySchema = TotalsSchema.extend({
  date: z.string().describe('Calendar day (YYYY-MM-DD) in SYMBOL_TIMEZONE or UTC.'),
});

const ReceiptRowSchema = z.object({
  height: z.number(),
  timestamp: InstantSchema,
  kind: z.enum(['harvester', 'beneficiary', 'unknown']),
  xym: z.string(),
  raw: z.string(),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  address: z.string(),
  currency: z.object({
    id: z.string(),
    alias: nullable(z.string(), 'Alias of the currency mosaic (symbol.xym); null when none.'),
    divisibility: z.number(),
  }),
  period: z.object({
    kind: z.enum(['dates', 'heights']),
    fromDate: nullable(z.string(), 'Requested first day; null when heights were given.'),
    toDate: nullable(z.string(), 'Requested last day; null when heights were given.'),
    timeZone: z
      .string()
      .describe('Zone used for day boundaries and daily buckets: IANA name or UTC.'),
  }),
  range: z.object({
    fromHeight: z.number(),
    toHeight: z.number(),
    fromTime: InstantSchema,
    toTime: InstantSchema,
    blocks: z.number(),
  }),
  totals: TotalsSchema,
  daily: z.array(DailySchema).optional(),
  receipts: z.array(ReceiptRowSchema).optional(),
  receiptsListed: z.number(),
  unknownStatements: z.number(),
  shares: z.object({
    harvesterPercentage: z.number(),
    beneficiaryPercentage: z.number(),
    networkPercentage: z.number(),
  }),
  pagesFetched: z.number(),
  statementsFetched: z.number(),
  truncated: z.boolean(),
  truncationReasons: z.array(z.enum(['pageLimit', 'receiptList'])),
  notes: z.array(z.string()),
});

type Period =
  | { readonly kind: 'dates'; readonly from: CalendarDate; readonly to: CalendarDate }
  | { readonly kind: 'heights'; readonly fromHeight: number; readonly toHeight: number };

function resolvePeriod(input: z.output<typeof inputSchema>): Period {
  const hasDate = input.fromDate !== undefined || input.toDate !== undefined;
  const hasHeight = input.fromHeight !== undefined || input.toHeight !== undefined;
  if (hasDate && hasHeight) {
    throw new ToolInputError(`Both a date range and a height range were given. ${PERIOD_HINT}`);
  }
  if (!hasDate && !hasHeight) {
    throw new ToolInputError(`No period was given. ${PERIOD_HINT}`);
  }
  if (hasDate) {
    if (input.fromDate === undefined || input.toDate === undefined) {
      throw new ToolInputError(`fromDate and toDate must be given together. ${PERIOD_HINT}`);
    }
    const parse = (label: string, value: string): CalendarDate => {
      try {
        return parseCalendarDate(value);
      } catch {
        throw new ToolInputError(
          `${label} "${value.trim().slice(0, 32)}" is not a valid YYYY-MM-DD date. ${PERIOD_HINT}`,
        );
      }
    };
    const from = parse('fromDate', input.fromDate);
    const to = parse('toDate', input.toDate);
    if (compareCalendarDates(from, to) > 0) {
      throw new ToolInputError(
        `fromDate ${formatCalendarDate(from)} is after toDate ${formatCalendarDate(to)}. Swap them or widen the period.`,
      );
    }
    return { kind: 'dates', from, to };
  }
  if (input.fromHeight === undefined || input.toHeight === undefined) {
    throw new ToolInputError(`fromHeight and toHeight must be given together. ${PERIOD_HINT}`);
  }
  if (input.fromHeight > input.toHeight) {
    throw new ToolInputError(
      `fromHeight ${formatInteger(input.fromHeight)} is above toHeight ${formatInteger(input.toHeight)}. Swap them or widen the period.`,
    );
  }
  return { kind: 'heights', fromHeight: input.fromHeight, toHeight: input.toHeight };
}

function flatTotals(t: HarvestTotals, divisibility: number): z.output<typeof TotalsSchema> {
  return {
    receipts: t.receipts,
    xym: formatAmount(t.raw, divisibility),
    raw: t.raw.toString(),
    receiptsHarvester: t.harvester.receipts,
    xymHarvester: formatAmount(t.harvester.raw, divisibility),
    rawHarvester: t.harvester.raw.toString(),
    receiptsBeneficiary: t.beneficiary.receipts,
    xymBeneficiary: formatAmount(t.beneficiary.raw, divisibility),
    rawBeneficiary: t.beneficiary.raw.toString(),
    receiptsUnknown: t.unknown.receipts,
    xymUnknown: formatAmount(t.unknown.raw, divisibility),
    rawUnknown: t.unknown.raw.toString(),
  };
}

function plural(n: number, word: string): string {
  return `${formatInteger(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** Block timestamp lookup backed by `/blocks/{height}`, memoised per tool call. */
function blockTimestampLookup(ctx: AppContext): BlockTimestampLookup {
  const cache = new Map<number, Promise<number>>();
  return (height) => {
    let p = cache.get(height);
    if (!p) {
      p = ctx.rest
        .get(`/blocks/${height}`, BlockInfoSchema)
        .then((block) => Number(block.block.timestamp));
      cache.set(height, p);
    }
    return p;
  };
}

export const harvestingIncomeTool = defineTool({
  name: 'symbol_harvesting_income',
  title: 'Symbol harvesting income',
  description:
    'Total the harvest rewards (HarvestFee receipts of the network currency) an account received in a period, computed on the server with exact integer arithmetic: receipt count and XYM total, split into harvester (blocks the account harvested), beneficiary (blocks others harvested with this account as beneficiary) and unknown. Period is a date range (YYYY-MM-DD, resolved to heights from block timestamps) or a height range. granularity=daily gives per-day buckets, granularity=receipt lists each receipt. Read-only; no fiat conversion.',
  inputSchema,
  outputSchema,
  run: async (ctx, input) => {
    const period = resolvePeriod(input);
    const { granularity, format } = input;
    const timeZone = ctx.config.timeZone;
    const zoneLabel = timeZone ?? 'UTC';

    const [{ info }, { properties, currency }, chain] = await Promise.all([
      fetchAccount(ctx, input.account),
      ctx.getNetworkData(),
      ctx.rest.get('/chain/info', ChainInfoSchema),
    ]);
    const addressHex = info.account.address.toUpperCase();
    const base32 = hexAddressToBase32(addressHex);
    const currentHeight = parseHeight(chain.height);
    const epochAdjustment = properties.epochAdjustmentSeconds;
    const lookup = blockTimestampLookup(ctx);
    const notes: string[] = [];

    let fromHeight: number;
    let toHeight: number;
    if (period.kind === 'dates') {
      const startMs = dateToNetworkTimestamp(dayStart(period.from, timeZone), epochAdjustment);
      const endMs = dateToNetworkTimestamp(dayEnd(period.to, timeZone), epochAdjustment);
      // Two independent binary searches, each sequential: at most two block requests in flight.
      const [first, last] = await Promise.all([
        firstHeightAtOrAfter(startMs, 1, currentHeight, lookup),
        lastHeightAtOrBefore(endMs, 1, currentHeight, lookup),
      ]);
      if (first === null) {
        const tip = ctx.instant(
          networkTimestampToDate(await lookup(currentHeight), epochAdjustment),
        );
        throw new ToolInputError(
          `fromDate ${formatCalendarDate(period.from)} (${zoneLabel}) is after the latest block (height ${formatInteger(currentHeight)}, ${formatInstantText(tip)}). Choose an earlier period.`,
        );
      }
      if (last === null) {
        const genesis = ctx.instant(networkTimestampToDate(await lookup(1), epochAdjustment));
        throw new ToolInputError(
          `toDate ${formatCalendarDate(period.to)} (${zoneLabel}) ends before the first block (${formatInstantText(genesis)}). Choose a later period.`,
        );
      }
      if (first > last) {
        throw new ToolInputError(
          `No block was produced between ${formatCalendarDate(period.from)} and ${formatCalendarDate(period.to)} (${zoneLabel}). Widen the period.`,
        );
      }
      fromHeight = first;
      toHeight = last;
      if (endMs > (await lookup(currentHeight))) {
        notes.push(
          `The period extends past the latest block (height ${formatInteger(currentHeight)}); later blocks are not included yet.`,
        );
      }
    } else {
      if (period.fromHeight > currentHeight) {
        throw new ToolInputError(
          `fromHeight ${formatInteger(period.fromHeight)} is above the current height ${formatInteger(currentHeight)} on ${ctx.network.name}. Choose an earlier range.`,
        );
      }
      fromHeight = period.fromHeight;
      toHeight = Math.min(period.toHeight, currentHeight);
      if (toHeight !== period.toHeight) {
        notes.push(
          `toHeight ${formatInteger(period.toHeight)} is above the current height; the range was capped at ${formatInteger(currentHeight)}.`,
        );
      }
    }

    const [fromTs, toTs] = await Promise.all([lookup(fromHeight), lookup(toHeight)]);
    const fromTime = ctx.instant(networkTimestampToDate(fromTs, epochAdjustment));
    const toTime = ctx.instant(networkTimestampToDate(toTs, epochAdjustment));

    // Every HarvestFee statement addressed to the account, oldest first, 100 per page.
    const harvestFeeType = receiptTypeCode('HarvestFee');
    const statements: TransactionStatementInfo[] = [];
    let pagesFetched = 0;
    let complete = false;
    for (let pageNumber = 1; pageNumber <= MAX_STATEMENT_PAGES; pageNumber++) {
      const params = new URLSearchParams({
        receiptType: String(harvestFeeType),
        targetAddress: base32,
        fromHeight: String(fromHeight),
        toHeight: String(toHeight),
        pageSize: String(STATEMENT_PAGE_SIZE),
        order: 'asc',
        pageNumber: String(pageNumber),
      });
      const page = await ctx.rest.get(
        `/statements/transaction?${params.toString()}`,
        TransactionStatementPageSchema,
      );
      pagesFetched += 1;
      statements.push(...page.data);
      if (page.data.length < STATEMENT_PAGE_SIZE) {
        complete = true;
        break;
      }
    }

    const shares = {
      beneficiaryPercentage: properties.harvestBeneficiaryPercentage,
      networkPercentage: properties.harvestNetworkPercentage,
    };
    const aggregate = aggregateHarvestIncome(statements, {
      targetAddressHex: addressHex,
      currencyMosaicId: currency.mosaicId,
      harvestFeeType,
      shares,
      epochAdjustmentSeconds: epochAdjustment,
      timeZone,
    });
    const div = currency.divisibility;
    const label = currency.alias ?? currency.mosaicId;
    const totals = flatTotals(aggregate.totals, div);

    const truncationReasons: Array<'pageLimit' | 'receiptList'> = [];
    if (!complete) truncationReasons.push('pageLimit');

    const receiptLimit = format === 'detailed' ? DETAILED_RECEIPT_LIMIT : CONCISE_RECEIPT_LIMIT;
    const receiptRows =
      granularity === 'receipt'
        ? aggregate.rows.slice(0, receiptLimit).map((r) => ({
            height: r.height,
            timestamp: ctx.instant(r.time),
            kind: r.kind,
            xym: formatAmount(r.raw, div),
            raw: r.raw.toString(),
          }))
        : undefined;
    if (receiptRows && receiptRows.length < aggregate.rows.length) {
      truncationReasons.push('receiptList');
    }
    const daily =
      granularity === 'daily'
        ? aggregate.daily.map((d) => ({ date: d.date, ...flatTotals(d, div) }))
        : undefined;

    const periodText =
      period.kind === 'dates'
        ? `${formatCalendarDate(period.from)} to ${formatCalendarDate(period.to)} (${zoneLabel}; heights ${formatInteger(fromHeight)}-${formatInteger(toHeight)}, ${plural(toHeight - fromHeight + 1, 'block')})`
        : `heights ${formatInteger(fromHeight)}-${formatInteger(toHeight)} (${formatInstantText(fromTime)} to ${formatInstantText(toTime)})`;
    const lines: string[] = [
      `${base32} on ${ctx.network.name}, ${periodText}: ${plural(totals.receipts, 'harvest receipt')} totalling ${totals.xym} ${label} (harvester ${totals.xymHarvester} in ${plural(totals.receiptsHarvester, 'block')}, beneficiary ${totals.xymBeneficiary} in ${plural(totals.receiptsBeneficiary, 'block')}${totals.receiptsUnknown > 0 ? `, unknown ${totals.xymUnknown} in ${plural(totals.receiptsUnknown, 'receipt')}` : ''}).`,
    ];
    if (totals.receipts === 0) {
      lines.push(
        'No harvest receipts in this period. Check that the account harvests (symbol_harvesting_status) and that the period is not before its first harvested block.',
      );
    } else if (daily) {
      const shown = daily.slice(0, SUMMARY_DAYS);
      lines.push(
        `Per day (${zoneLabel}): ${shown.map((d) => `${d.date} ${d.xym} (${d.receipts})`).join(', ')}${daily.length > SUMMARY_DAYS ? `, and ${daily.length - SUMMARY_DAYS} more days in daily` : ''}.`,
      );
    } else if (receiptRows) {
      lines.push(
        `receipts lists ${formatInteger(receiptRows.length)} of ${formatInteger(aggregate.rows.length)} receipts${receiptRows.length < aggregate.rows.length ? (format === 'concise' ? ' (use format=detailed or a narrower period for the rest)' : ' (use a narrower period for the rest)') : ''}.`,
      );
    }
    if (aggregate.unknownStatements > 0) {
      lines.push(
        `${plural(aggregate.unknownStatements, 'statement')} had a share split that does not match ${shares.beneficiaryPercentage}% beneficiary / ${shares.networkPercentage}% network; those receipts are counted as unknown.`,
      );
    }
    if (!complete) {
      lines.push(
        `Only the first ${formatInteger(MAX_STATEMENT_PAGES * STATEMENT_PAGE_SIZE)} statements (${MAX_STATEMENT_PAGES} pages) were read, so the totals are incomplete. Narrow the period or split it with fromHeight/toHeight.`,
      );
    }

    notes.push(
      'Harvesting is probabilistic: income varies strongly from day to day, so short periods are not representative.',
      `Amounts are in ${label} only; no fiat conversion is applied.`,
      'harvester = blocks this account harvested (directly or through a delegated node); beneficiary = blocks harvested by others whose node names this account as beneficiary; unknown = receipts whose share split was not recognised.',
    );

    return {
      summary: lines.join('\n'),
      network: ctx.network.name,
      address: base32,
      currency: { id: currency.mosaicId, alias: currency.alias, divisibility: div },
      period: {
        kind: period.kind,
        fromDate: period.kind === 'dates' ? formatCalendarDate(period.from) : null,
        toDate: period.kind === 'dates' ? formatCalendarDate(period.to) : null,
        timeZone: zoneLabel,
      },
      range: { fromHeight, toHeight, fromTime, toTime, blocks: toHeight - fromHeight + 1 },
      totals,
      ...(daily ? { daily } : {}),
      ...(receiptRows ? { receipts: receiptRows } : {}),
      receiptsListed: receiptRows?.length ?? 0,
      unknownStatements: aggregate.unknownStatements,
      shares: {
        harvesterPercentage: 100 - shares.beneficiaryPercentage - shares.networkPercentage,
        beneficiaryPercentage: shares.beneficiaryPercentage,
        networkPercentage: shares.networkPercentage,
      },
      pagesFetched,
      statementsFetched: statements.length,
      truncated: truncationReasons.length > 0,
      truncationReasons,
      notes,
    };
  },
});
