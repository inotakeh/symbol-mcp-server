import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import { type TransactionStatus, TransactionStatusListSchema } from '../client/schemas.js';
import { parseHeight } from '../domain/epoch.js';
import { formatInstantText, type Instant, networkTimestampToDate } from '../domain/time.js';
import { describeTransactionStatusCode, TRANSACTION_GROUPS } from '../domain/txstatus.js';
import { defineTool, formatInteger, maskIdentifier, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';

/** Hashes checked per call; the node answers one POST for the whole batch. */
export const MAX_STATUS_HASHES = 20;

/**
 * Longest status code kept. The code is untrusted text from the node; the longest name in
 * TransactionStatusEnum has 67 characters.
 */
export const MAX_STATUS_CODE_LENGTH = 128;

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
      return `${short} failed: ${entry.code ?? 'no code reported'}${entry.codeMeaning ? ` (${entry.codeMeaning})` : ''}.`;
    default:
      return `${short} not found on this node: never announced here, rejected before being tracked, or already pruned; check the node that received the announce, or symbol_transaction_get for an older confirmed transaction.`;
  }
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
    let found: TransactionStatus[];
    try {
      found = await ctx.rest.post('/transactionStatus', { hashes }, TransactionStatusListSchema);
    } catch (err) {
      // A 404 for the whole batch means the node tracks none of them: not an error for the caller.
      if (err instanceof RestError && err.kind === 'not_found') found = [];
      else throw err;
    }
    const byHash = new Map(found.map((s) => [s.hash.toUpperCase(), s] as const));

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
      // Cleaned before it is looked up, so the meaning always belongs to the code that is shown;
      // nothing left after cleaning counts as no code reported.
      const code = text.clean(s.code ?? '', MAX_STATUS_CODE_LENGTH) || null;
      const height = s.height === undefined ? 0 : parseHeight(s.height);
      return {
        hash,
        group: s.group,
        code,
        codeMeaning:
          code !== null && code !== 'Success' ? describeTransactionStatusCode(code) : null,
        height: s.group === 'confirmed' && height > 0 ? height : null,
        deadline: ctx.instant(
          networkTimestampToDate(s.deadline, properties.epochAdjustmentSeconds),
        ),
      };
    });

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
