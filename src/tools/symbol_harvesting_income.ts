import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import {
  BlockInfoSchema,
  ChainInfoSchema,
  type TransactionStatementInfo,
  TransactionStatementPageSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount, groupThousands } from '../domain/amount.js';
import { type CsvCell, toCsv } from '../domain/csv.js';
import { parseHeight } from '../domain/epoch.js';
import {
  aggregateHarvestIncome,
  type BlockTimestampLookup,
  blocksForDays,
  CHUNK_DAYS,
  firstHeightAtOrAfter,
  type HarvestTotals,
  lastHeightAtOrBefore,
  MIN_CHUNK_DAYS,
  shrinkChunkBlocks,
  splitHeightRange,
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
import { AccountResolutionSchema, withResolutionPrefix } from './_accounts.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';
import { fetchAccount } from './symbol_account_get.js';

/** catapult-rest caps statement pages at 100 entries. */
export const STATEMENT_PAGE_SIZE = 100;
/** Hard stop: 200 pages = 20,000 statements per call, counted across all height chunks. */
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
      'Account whose harvest income to total: base32 address (39 chars), hex public key (64 chars), or a namespace name with an address alias (e.g. alice, alice.pay; resolved through the node). Hex addresses (48 chars) are also accepted.',
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
    .enum(['daily', 'monthly', 'receipt'])
    .default('daily')
    .describe(
      'daily (default): one row per calendar day with receipts. monthly: one row per calendar month (SYMBOL_TIMEZONE or UTC), for yearly or multi-month questions. receipt: one row per receipt (block, time, kind, amount).',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      `Detail level of the JSON; only affects granularity=receipt: concise lists at most ${CONCISE_RECEIPT_LIMIT} receipts, detailed at most ${DETAILED_RECEIPT_LIMIT}. Totals always cover the whole period. Independent of output.`,
    ),
  output: z
    .enum(['json', 'csv'])
    .default('json')
    .describe(
      'Form of the text content block. json (default): the structuredContent JSON. csv: an RFC 4180 CSV for spreadsheets with one row per day, month or receipt (following granularity, and the receipt cap of format); structuredContent stays JSON and repeats the CSV in its csv field. Independent of format.',
    ),
});

const BUCKET_CSV_HEADER = [
  'period',
  'receipts',
  'xym',
  'raw',
  'receipts_harvester',
  'xym_harvester',
  'raw_harvester',
  'receipts_beneficiary',
  'xym_beneficiary',
  'raw_beneficiary',
  'receipts_unknown',
  'xym_unknown',
  'raw_unknown',
];
const RECEIPT_CSV_HEADER = ['height', 'timestamp_utc', 'timestamp_local', 'kind', 'xym', 'raw'];

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

const MonthlySchema = TotalsSchema.extend({
  month: z.string().describe('Calendar month (YYYY-MM) in SYMBOL_TIMEZONE or UTC.'),
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
  accountResolution: AccountResolutionSchema,
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
  monthly: z.array(MonthlySchema).optional(),
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
  fetch: z
    .object({
      chunks: z.number().describe('Height chunks that were read.'),
      chunkBlocks: z
        .number()
        .describe('Initial chunk length in blocks (about 90 days at the target block time).'),
      splitRetries: z
        .number()
        .describe('Times a chunk was halved because the node timed out on its first page.'),
      pagesFetched: z.number().describe('Statement pages read over all chunks.'),
    })
    .describe('How the statements were read: wide ranges are split into height chunks.'),
  truncated: z.boolean(),
  truncationReasons: z.array(z.enum(['pageLimit', 'receiptList'])),
  notes: z.array(z.string()),
  csv: nullable(
    z.string(),
    'CSV body when output=csv (identical to the text content block: header row, one row per day / month / receipt, LF line endings); null for output=json.',
  ),
});

function bucketCsvRow(period: string, t: z.output<typeof TotalsSchema>): CsvCell[] {
  return [
    period,
    t.receipts,
    t.xym,
    t.raw,
    t.receiptsHarvester,
    t.xymHarvester,
    t.rawHarvester,
    t.receiptsBeneficiary,
    t.xymBeneficiary,
    t.rawBeneficiary,
    t.receiptsUnknown,
    t.xymUnknown,
    t.rawUnknown,
  ];
}

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

interface StatementFetchOptions {
  readonly base32: string;
  readonly harvestFeeType: number;
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly chunkBlocks: number;
  readonly minChunkBlocks: number;
}

interface StatementFetchResult {
  readonly statements: TransactionStatementInfo[];
  readonly pagesFetched: number;
  readonly chunks: number;
  readonly splitRetries: number;
  /** False when MAX_STATEMENT_PAGES ran out before the last chunk was read. */
  readonly complete: boolean;
}

/**
 * Reads the statements chunk by chunk, sequentially (one request in flight), 100 per page with
 * the page number restarting in every chunk. When the FIRST page of a chunk times out, the rest
 * of the range is re-split with half the chunk length (kept for the rest of the call) and read
 * again from the same height; at the minimum length the timeout is final. Any other failure, and
 * a timeout on a later page, propagates unchanged.
 */
async function fetchHarvestStatements(
  ctx: AppContext,
  options: StatementFetchOptions,
): Promise<StatementFetchResult> {
  const statements: TransactionStatementInfo[] = [];
  let pagesFetched = 0;
  let chunks = 0;
  let splitRetries = 0;
  let pending = splitHeightRange(options.fromHeight, options.toHeight, options.chunkBlocks);

  for (let range = pending[0]; range !== undefined; range = pending[0]) {
    let chunkDone = false;
    for (let pageNumber = 1; !chunkDone; pageNumber++) {
      if (pagesFetched >= MAX_STATEMENT_PAGES) {
        return { statements, pagesFetched, chunks, splitRetries, complete: false };
      }
      const params = new URLSearchParams({
        receiptType: String(options.harvestFeeType),
        targetAddress: options.base32,
        fromHeight: String(range.fromHeight),
        toHeight: String(range.toHeight),
        pageSize: String(STATEMENT_PAGE_SIZE),
        order: 'asc',
        pageNumber: String(pageNumber),
      });
      let page: z.output<typeof TransactionStatementPageSchema>;
      try {
        page = await ctx.rest.get(
          `/statements/transaction?${params.toString()}`,
          TransactionStatementPageSchema,
        );
      } catch (err) {
        if (!(err instanceof RestError) || err.kind !== 'timeout' || pageNumber !== 1) throw err;
        const length = range.toHeight - range.fromHeight + 1;
        const smaller = shrinkChunkBlocks(length, options.minChunkBlocks);
        if (smaller === null) {
          throw new ToolInputError(
            `Node ${ctx.rest.host} did not answer /statements/transaction for heights ${formatInteger(range.fromHeight)}-${formatInteger(range.toHeight)} (${plural(length, 'block')}) within ${ctx.config.requestTimeoutMs} ms, even after shrinking the query to about ${MIN_CHUNK_DAYS} days. The node is not responding: narrow the range with fromHeight/toHeight, or raise SYMBOL_REQUEST_TIMEOUT_MS (currently ${ctx.config.requestTimeoutMs}).`,
          );
        }
        splitRetries += 1;
        pending = splitHeightRange(range.fromHeight, options.toHeight, smaller);
        break;
      }
      pagesFetched += 1;
      statements.push(...page.data);
      chunkDone = page.data.length < STATEMENT_PAGE_SIZE;
    }
    if (chunkDone) {
      chunks += 1;
      pending = pending.slice(1);
    }
  }
  return { statements, pagesFetched, chunks, splitRetries, complete: true };
}

export const harvestingIncomeTool = defineTool({
  name: 'symbol_harvesting_income',
  title: 'Symbol harvesting income',
  description:
    "Total the harvest rewards an account received in a period; use this tool whenever the user asks about harvesting rewards, harvest income, or earnings for a period (e.g. 'last month', 'this year', 'per day'). Do not use symbol_transaction_search or a browser for this (harvest rewards are receipts, not transactions); for why an account earns nothing, use symbol_delegation_diagnose. " +
    'The rewards are the HarvestFee receipts of the network currency, totalled on the server with exact integer arithmetic: receipt count and XYM total, split into harvester (blocks the account harvested), beneficiary (blocks others harvested with this account as beneficiary) and unknown. Period is a date range (YYYY-MM-DD, resolved to heights from block timestamps) or a height range. granularity=daily gives per-day buckets, granularity=monthly per-calendar-month buckets (yearly questions), granularity=receipt lists each receipt; output=csv returns the same rows as CSV text for a spreadsheet. Periods of a year or more are fine: the range is read in chunks internally. Read-only; no fiat conversion.',
  inputSchema,
  outputSchema,
  renderText: (out) => out.csv ?? undefined,
  run: async (ctx, input) => {
    const period = resolvePeriod(input);
    const { granularity, format, output } = input;
    const timeZone = ctx.config.timeZone;
    const zoneLabel = timeZone ?? 'UTC';

    const [{ info, resolution }, { properties, currency }, chain] = await Promise.all([
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

    // Every HarvestFee statement addressed to the account, oldest first, in height chunks.
    const harvestFeeType = receiptTypeCode('HarvestFee');
    const chunkBlocks = blocksForDays(CHUNK_DAYS, properties.blockGenerationTargetTimeMs);
    const minChunkBlocks = blocksForDays(MIN_CHUNK_DAYS, properties.blockGenerationTargetTimeMs);
    const fetched = await fetchHarvestStatements(ctx, {
      base32,
      harvestFeeType,
      fromHeight,
      toHeight,
      chunkBlocks,
      minChunkBlocks,
    });
    const { statements, pagesFetched, complete } = fetched;

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
    const monthly =
      granularity === 'monthly'
        ? aggregate.monthly.map((m) => ({ month: m.month, ...flatTotals(m, div) }))
        : undefined;

    let csv: string | null = null;
    if (output === 'csv') {
      if (receiptRows) {
        csv = toCsv(
          RECEIPT_CSV_HEADER,
          receiptRows.map((r) => [
            r.height,
            r.timestamp.utc,
            r.timestamp.local ?? '',
            r.kind,
            r.xym,
            r.raw,
          ]),
        );
      } else if (monthly) {
        csv = toCsv(
          BUCKET_CSV_HEADER,
          monthly.map((m) => bucketCsvRow(m.month, m)),
        );
      } else {
        csv = toCsv(
          BUCKET_CSV_HEADER,
          (daily ?? []).map((d) => bucketCsvRow(d.date, d)),
        );
      }
    }

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
    } else if (monthly) {
      // One line per month after the period total; the total stays first however many months.
      for (const m of monthly) {
        lines.push(
          `${m.month}: ${plural(m.receipts, 'receipt')}, ${groupThousands(m.xym)} ${label} (${formatInteger(m.receiptsHarvester)} harvester / ${formatInteger(m.receiptsBeneficiary)} beneficiary${m.receiptsUnknown > 0 ? ` / ${formatInteger(m.receiptsUnknown)} unknown` : ''})`,
        );
      }
    } else if (receiptRows) {
      lines.push(
        `receipts lists ${formatInteger(receiptRows.length)} of ${formatInteger(aggregate.rows.length)} receipts${receiptRows.length < aggregate.rows.length ? (format === 'concise' ? ' (use format=detailed or a narrower period for the rest)' : ' (use a narrower period for the rest)') : ''}.`,
      );
    }
    if (csv !== null) {
      const dataRows = csv.split('\n').length - 2;
      lines.push(
        `CSV: ${plural(dataRows, 'data row')} (${granularity}) in the text block and in the csv field; the totals above are the same data.`,
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

    if (fetched.splitRetries > 0) {
      lines.push(
        `(the node timed out on ${formatInteger(fetched.splitRetries)} wide ${fetched.splitRetries === 1 ? 'query' : 'queries'}; retried with smaller chunks)`,
      );
    }

    notes.push(
      `Wide ranges are read in chunks of about ${CHUNK_DAYS} days (${formatInteger(chunkBlocks)} blocks), halved down to about ${MIN_CHUNK_DAYS} days when the node times out on a chunk; the totals are the same as from one query.`,
      'Harvesting is probabilistic: income varies strongly from day to day, so short periods are not representative.',
      `Amounts are in ${label} only; no fiat conversion is applied.`,
      'harvester = blocks this account harvested (directly or through a delegated node); beneficiary = blocks harvested by others whose node names this account as beneficiary; unknown = receipts whose share split was not recognised.',
    );

    return {
      summary: withResolutionPrefix(lines.join('\n'), resolution),
      network: ctx.network.name,
      accountResolution: resolution,
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
      ...(monthly ? { monthly } : {}),
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
      fetch: {
        chunks: fetched.chunks,
        chunkBlocks,
        splitRetries: fetched.splitRetries,
        pagesFetched,
      },
      truncated: truncationReasons.length > 0,
      truncationReasons,
      notes,
      csv,
    };
  },
});
