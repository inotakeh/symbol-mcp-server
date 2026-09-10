import * as z from 'zod/v4';
import { TransactionPageSchema } from '../client/schemas.js';
import { classifyAccountId, publicKeyToAddress } from '../domain/address.js';
import { formatInstantText } from '../domain/time.js';
import { summarizeTransaction, type TransactionSummary } from '../domain/transaction.js';
import { parseTransactionType, transactionTypeNames } from '../domain/txtype.js';
import { defineTool, formatInteger, maskIdentifier, nullable, ToolInputError } from './_shared.js';
import { buildSummarizeOptions, TransactionSummarySchema, TypeSchema } from './_transactions.js';
import { ACCOUNT_INPUT_HINT } from './symbol_account_get.js';
import { describeTransactionLine, UNTRUSTED_TEXT_NOTE } from './symbol_transaction_get.js';

/** catapult-rest coerces pageSize below 10 to 10 and caps it at 100 (see the captured fixture). */
export const MIN_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_NUMBER = 10_000;
const CONCISE_MESSAGE_PREVIEW = 80;

const inputSchema = z.object({
  address: z
    .string()
    .min(1)
    .describe(
      'Account whose transactions to list: base32 address (39 chars) or hex public key (64 chars). Matches transactions where the account is signer or recipient.',
    ),
  type: z
    .string()
    .optional()
    .describe(
      'Optional transaction type filter: a name such as Transfer, AggregateComplete, VotingKeyLink (case-insensitive), or a numeric code such as 16724.',
    ),
  pageSize: z
    .number()
    .int()
    .min(MIN_PAGE_SIZE)
    .max(MAX_PAGE_SIZE)
    .default(MIN_PAGE_SIZE)
    .describe(
      'Transactions per page, 10 (default) to 100. The node does not support fewer than 10.',
    ),
  pageNumber: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_NUMBER)
    .default(1)
    .describe(`1-based page number (1 to ${MAX_PAGE_NUMBER}).`),
  order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('desc (default): newest first. asc: oldest first.'),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): messages are cut to an 80-character preview. detailed: full message text. Both include deadline and type-specific details.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  address: z.string(),
  filter: z.object({
    type: nullable(TypeSchema, 'Applied type filter; null when listing every type.'),
  }),
  order: z.enum(['asc', 'desc']),
  format: z.enum(['concise', 'detailed']),
  transactions: z.array(TransactionSummarySchema),
  pagination: z.object({
    pageNumber: z.number(),
    pageSize: z.number(),
    count: z.number(),
    hasMore: z.boolean(),
    nextPageNumber: nullable(z.number(), 'Page to request next; null on the last page.'),
  }),
});

function conciseRow(t: TransactionSummary): TransactionSummary {
  const message =
    t.message?.kind === 'plain' && (t.message.messageText?.length ?? 0) > CONCISE_MESSAGE_PREVIEW
      ? {
          ...t.message,
          messageText: `${t.message.messageText?.slice(0, CONCISE_MESSAGE_PREVIEW)}…`,
          note: 'Message preview truncated; use format=detailed for the full text.',
        }
      : t.message;
  return { ...t, message };
}

export const transactionSearchTool = defineTool({
  name: 'symbol_transaction_search',
  title: 'Symbol transaction search',
  description:
    'List confirmed transactions involving a Symbol account (as signer or recipient), newest first by default, optionally filtered by type. Each row has the type name, hash, height and time, signer and recipient addresses, mosaics with alias names and adjusted amounts, decoded message and fees. Paginated: 10 to 100 rows per page; the summary says how to fetch the next page. ' +
    UNTRUSTED_TEXT_NOTE,
  inputSchema,
  outputSchema,
  run: async (ctx, { address, type, pageSize, pageNumber, order, format }) => {
    const classified = classifyAccountId(address);
    if (classified.kind === 'invalid') {
      throw new ToolInputError(
        `"${maskIdentifier(address.trim())}" is not a valid Symbol account identifier. ${ACCOUNT_INPUT_HINT}`,
      );
    }
    const base32 =
      classified.kind === 'publicKey'
        ? publicKeyToAddress(classified.canonical, ctx.network.identifier)
        : classified.canonical;

    let typeFilter: { code: number; name: string } | null = null;
    if (type !== undefined && type.trim() !== '') {
      const parsed = parseTransactionType(type);
      if (!parsed) {
        throw new ToolInputError(
          `"${type.trim().slice(0, 32)}" is not a known transaction type. Use a name such as ${transactionTypeNames().slice(0, 6).join(', ')} (case-insensitive) or a numeric code such as 16724.`,
        );
      }
      typeFilter = parsed;
    }

    const params = new URLSearchParams({
      address: base32,
      pageSize: String(pageSize),
      pageNumber: String(pageNumber),
      order,
    });
    if (typeFilter) params.set('type', String(typeFilter.code));
    const [page, { currency }] = await Promise.all([
      ctx.rest.get(`/transactions/confirmed?${params.toString()}`, TransactionPageSchema),
      ctx.getNetworkData(),
    ]);
    const opts = await buildSummarizeOptions(ctx, page.data);
    const full = page.data.map((info) => summarizeTransaction(info, opts));
    const transactions = format === 'concise' ? full.map(conciseRow) : full;
    const currencyLabel = currency.alias ?? currency.mosaicId;

    const hasMore = page.data.length >= pageSize;
    const nextPageNumber = hasMore ? pageNumber + 1 : null;
    const lines: string[] = [
      `${base32} on ${ctx.network.name}: ${transactions.length} ${typeFilter ? `${typeFilter.name} ` : ''}transaction${transactions.length === 1 ? '' : 's'} on page ${pageNumber} (${order === 'desc' ? 'newest' : 'oldest'} first)${hasMore ? `; more may follow, request pageNumber=${nextPageNumber}` : '; this is the last page'}.`,
    ];
    for (const t of transactions.slice(0, 5)) {
      const when = t.timestamp ? formatInstantText(t.timestamp) : 'unknown time';
      lines.push(
        `- ${t.type.name} ${t.hash?.slice(0, 8) ?? '????????'}… at height ${t.height !== null ? formatInteger(t.height) : '?'} (${when}): ${describeTransactionLine(t, currencyLabel)}`,
      );
    }
    if (transactions.length > 5)
      lines.push(`… and ${transactions.length - 5} more in the transactions array.`);
    if (transactions.length === 0 && pageNumber === 1) {
      lines.push(
        'No confirmed transactions match. Check the address/type filter and whether you meant mainnet or testnet.',
      );
    }

    return {
      summary: lines.join('\n'),
      network: ctx.network.name,
      address: base32,
      filter: { type: typeFilter },
      order,
      format,
      transactions,
      pagination: {
        pageNumber,
        pageSize,
        count: transactions.length,
        hasMore,
        nextPageNumber,
      },
    };
  },
});
