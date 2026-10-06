/**
 * The node's status of a transaction (`POST /transactionStatus`) as symbol_transaction_status and
 * symbol_transaction_get both read it. The request, the cleaning of the status code with the
 * lookup of its meaning, and the wording of a failed status in a summary are each written once,
 * here, so the two tools cannot judge the same answer differently.
 */
import { RestError } from '../client/rest.js';
import { type TransactionStatus, TransactionStatusListSchema } from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { labelledQuote } from '../domain/quote.js';
import type { UntrustedText } from '../domain/sanitize.js';
import { describeTransactionStatusCode, TRANSACTION_STATUS_CODES } from '../domain/txstatus.js';

/**
 * Longest status code kept. The code is untrusted text from the node; the longest name in
 * TransactionStatusEnum has 67 characters.
 */
export const MAX_STATUS_CODE_LENGTH = 128;

/**
 * What the node knows about `hashes` (upper-case hex), by hash, from one POST for the whole list.
 * A hash the node does not track is absent, and so is every hash when the node answers the
 * request with a 404. Any other failure of the request is thrown.
 */
export async function fetchTransactionStatuses(
  ctx: AppContext,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, TransactionStatus>> {
  let found: TransactionStatus[];
  try {
    found = await ctx.rest.post('/transactionStatus', { hashes }, TransactionStatusListSchema);
  } catch (err) {
    // A 404 for the whole batch means the node tracks none of them: not an error for the caller.
    if (err instanceof RestError && err.kind === 'not_found') found = [];
    else throw err;
  }
  return new Map(found.map((s) => [s.hash.toUpperCase(), s] as const));
}

/** A status code as the output shows it, with its meaning. */
export interface StatusCode {
  /** The cleaned code; null when the node reported none, or nothing was left after cleaning. */
  readonly code: string | null;
  /** Its explanation in TransactionStatusEnum; null for Success and for a code without one. */
  readonly codeMeaning: string | null;
}

/**
 * The status code the node sent. It is cleaned before it is looked up, so the meaning always
 * belongs to the code that is shown; nothing left after cleaning counts as no code reported.
 */
export function readStatusCode(raw: string | undefined, text: UntrustedText): StatusCode {
  const code = text.clean(raw ?? '', MAX_STATUS_CODE_LENGTH) || null;
  return {
    code,
    codeMeaning: code !== null && code !== 'Success' ? describeTransactionStatusCode(code) : null,
  };
}

/**
 * The node's status code for a summary line: a code of TransactionStatusEnum stays as it is, and
 * anything else the node sent is labelled and quoted (domain/quote.ts).
 */
export function statusCodeText(code: string | null): string {
  if (code === null) return 'no code reported';
  return TRANSACTION_STATUS_CODES.has(code) ? code : labelledQuote('code', code);
}

/** A failed status for a summary line: `failed: <code> (<meaning>)`, without the final period. */
export function failedStatusText({ code, codeMeaning }: StatusCode): string {
  return `failed: ${statusCodeText(code)}${codeMeaning ? ` (${codeMeaning})` : ''}`;
}
