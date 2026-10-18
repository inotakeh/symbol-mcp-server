import * as z from 'zod/v4';
import { parseHeight } from '../domain/epoch.js';
import {
  formatInstant,
  formatInstantText,
  type Instant,
  InvalidNetworkTimestampError,
  networkTimestampToDate,
} from '../domain/time.js';
import { TRANSACTION_GROUPS } from '../domain/txstatus.js';
import {
  defineTool,
  formatInteger,
  logUnusableTime,
  maskIdentifier,
  nullable,
  ToolInputError,
} from './_shared.js';
import { InstantSchema } from './_transactions.js';
import { failedStatusText, fetchTransactionStatuses, readStatusCode } from './_txstatus.js';

/** Hashes checked per call; the node answers one POST for the whole batch. */
export const MAX_STATUS_HASHES = 20;

const HASH_HINT = `Pass 1 to ${MAX_STATUS_HASHES} transaction hashes, each the 64-character hex hash printed when the transaction was announced (symbol_transaction_search lists hashes for an address).`;

const inputSchema = z.object({
  transactionHashes: z
    .array(z.string())
    .describe(
      `Transaction hashes to check, 1 to ${MAX_STATUS_HASHES} entries of 64 hex characters each. Always an array, even for a single hash.`,
    ),
});

const StatusEntrySchema = z.object({
  hash: z.string(),
  group: z.enum([...TRANSACTION_GROUPS, 'not_found']),
  code: nullable(
    z.string(),
    'Validation result reported by the node: Success, or a Failure_* / Neutral_* code. Null when not found or not reported.',
  ),
  codeMeaning: nullable(
    z.string(),
    'Explanation of a non-Success code from the REST API TransactionStatusEnum. Null for Success, for codes the enum does not explain, and when not found.',
  ),
  height: nullable(z.number(), 'Block height of a confirmed transaction; null otherwise.'),
  deadline: nullable(
    InstantSchema,
    'Deadline the transaction was announced with; null when not found.',
  ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  statuses: z.array(StatusEntrySchema),
  counts: z.object({
    confirmed: z.number(),
    unconfirmed: z.number(),
    partial: z.number(),
    failed: z.number(),
    notFound: z.number(),
  }),
  note: z.string(),
});

const NODE_NOTE =
  'Statuses come from the configured node. A transaction announced to a different node may show as not_found, or as failed without a detailed code, until it propagates; the node that received the announce has the most detailed result.';

interface StatusEntry {
  readonly hash: string;
  readonly group: (typeof TRANSACTION_GROUPS)[number] | 'not_found';
  readonly code: string | null;
  readonly codeMeaning: string | null;
  readonly height: number | null;
  readonly deadline: Instant | null;
}

function describeStatus(entry: StatusEntry): string {
  const short = `${entry.hash.slice(0, 8)}…`;
  const deadline = entry.deadline ? `deadline ${formatInstantText(entry.deadline)}` : '';
  switch (entry.group) {
    case 'confirmed':
      return `${short} confirmed at height ${entry.height === null ? 'unknown' : formatInteger(entry.height)}.`;
    case 'unconfirmed':
      return `${short} unconfirmed: accepted into the mempool, not yet in a block (${deadline}).`;
    case 'partial':
      return `${short} partial: waiting for cosignatures (aggregate bonded with missing cosignatures; it confirms only after every required cosigner signs before the ${deadline}).`;
    case 'failed':
      return `${short} ${failedStatusText(entry)}.`;
    default:
      return `${short} not found on this node: never announced here, rejected before being tracked, or already pruned; check the node that received the announce, or symbol_transaction_get for an older confirmed transaction.`;
  }
}

/** A status row whose deadline gives no date: the hash the caller passed, and the row's group. */
interface UnusableDeadline {
  readonly hash: string;
  readonly group: (typeof TRANSACTION_GROUPS)[number];
}

/**
 * What the tool answers when a deadline gives no date (the schema accepts any uint64). It names
 * every transaction concerned, so that the call can be repeated without them; the general text of
 * describeError could not say which of up to 20 hashes it was. The deadline itself is not quoted.
 * symbol_transaction_get is named only when a row is failed: for the other groups it converts
 * the deadline of the transaction too.
 */
function unusableDeadlineText(host: string, rows: readonly UnusableDeadline[]): string {
  const one = rows.length === 1;
  const named = rows.map((row) => `${maskIdentifier(row.hash)} (${row.group})`).join(', ');
  const failedHint = rows.some((row) => row.group === 'failed')
    ? ' For a failed transaction, symbol_transaction_get reports the validation code and its meaning without reading the deadline.'
    : '';
  return `Node ${host} reports a deadline that cannot be shown as a date for transaction${one ? '' : 's'} ${named}, so no status of this call could be returned. Call symbol_transaction_status again without ${one ? 'that hash' : 'those hashes'}.${failedHint}`;
}

export const transactionStatusTool = defineTool({
  name: 'symbol_transaction_status',
  title: 'Symbol transaction status',
  description:
    "Track where one or more Symbol transactions stand right now, by hash: confirmed (in a block, with the height), unconfirmed (in the mempool), partial (aggregate bonded waiting for cosignatures), failed (with the node's validation code and its meaning) or not_found. For what a transaction contains, use symbol_transaction_get. Use this tool right after announcing a transaction, for example a voting/VRF/node key link, to see whether it went through, and to learn why a transaction failed; the node the transaction was announced to has the most detailed result. Up to 20 hashes per call.",
  inputSchema,
  outputSchema,
  untrustedText: true,
  run: async (ctx, { transactionHashes }, text) => {
    if (transactionHashes.length === 0) {
      throw new ToolInputError(`transactionHashes is empty. ${HASH_HINT}`);
    }
    if (transactionHashes.length > MAX_STATUS_HASHES) {
      throw new ToolInputError(
        `${transactionHashes.length} hashes were given but at most ${MAX_STATUS_HASHES} are checked per call. Split the list into batches of ${MAX_STATUS_HASHES} and call symbol_transaction_status once per batch.`,
      );
    }
    const hashes: string[] = [];
    for (const raw of transactionHashes) {
      const hash = raw.trim().toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(hash)) {
        throw new ToolInputError(
          `"${maskIdentifier(raw.trim())}" is not a transaction hash. ${HASH_HINT}`,
        );
      }
      if (!hashes.includes(hash)) hashes.push(hash);
    }

    const { properties } = await ctx.getNetworkData();
    const epochAdjustment = properties.epochAdjustmentSeconds;
    const byHash = await fetchTransactionStatuses(ctx, hashes);

    const unusable: UnusableDeadline[] = [];
    const deadlineOf = (row: UnusableDeadline, deadline: string): Instant | null => {
      try {
        return ctx.instant(networkTimestampToDate(deadline, epochAdjustment));
      } catch (err) {
        if (!(err instanceof InvalidNetworkTimestampError)) throw err;
        // An epoch adjustment that is no time fails every deadline, and none is this row's fault:
        // formatInstant then throws, and describeError gives the general text.
        formatInstant(new Date(epochAdjustment * 1000));
        logUnusableTime(err, ctx.rest.host);
        unusable.push(row);
        return null;
      }
    };

    const statuses = hashes.map((hash): StatusEntry => {
      const s = byHash.get(hash);
      if (!s) {
        return {
          hash,
          group: 'not_found',
          code: null,
          codeMeaning: null,
          height: null,
          deadline: null,
        };
      }
      const { code, codeMeaning } = readStatusCode(s.code, text);
      const height = s.height === undefined ? 0 : parseHeight(s.height);
      return {
        hash,
        group: s.group,
        code,
        codeMeaning,
        height: s.group === 'confirmed' && height > 0 ? height : null,
        deadline: deadlineOf({ hash, group: s.group }, s.deadline),
      };
    });
    // No row is returned without its deadline: the call fails and names the rows to leave out.
    if (unusable.length > 0) {
      throw new ToolInputError(unusableDeadlineText(ctx.rest.host, unusable));
    }

    const counts = {
      confirmed: statuses.filter((s) => s.group === 'confirmed').length,
      unconfirmed: statuses.filter((s) => s.group === 'unconfirmed').length,
      partial: statuses.filter((s) => s.group === 'partial').length,
      failed: statuses.filter((s) => s.group === 'failed').length,
      notFound: statuses.filter((s) => s.group === 'not_found').length,
    };
    const lines = [
      `${statuses.length} transaction${statuses.length === 1 ? '' : 's'} checked on ${ctx.network.name} (node ${ctx.rest.host}): ${counts.confirmed} confirmed, ${counts.unconfirmed} unconfirmed, ${counts.partial} partial, ${counts.failed} failed, ${counts.notFound} not found.`,
      ...statuses.map(describeStatus),
    ];

    return {
      summary: lines.join('\n'),
      network: ctx.network.name,
      statuses,
      counts,
      note: NODE_NOTE,
    };
  },
});
