/**
 * Shared shape of the `checks[]` that the diagnosis-style tools return
 * (symbol_delegation_diagnose, symbol_node_health): a fixed-order list of
 * `{ id, status, detail, hint }` rows whose statuses a domain verdict function folds into one word.
 * The status vocabulary lives in domain/delegation.ts; this module only adds the zod schema and
 * the small constructors the tools share.
 */
import * as z from 'zod/v4';
import type { CheckStatus, DiagnoseCheck } from '../domain/delegation.js';
import { nullable } from './_shared.js';

export const CheckSchema = z.object({
  id: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'unknown']),
  detail: z.string(),
  hint: nullable(z.string(), 'What to do about this check; null when nothing is needed.'),
});

export interface CheckInput {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
}

export function check(input: CheckInput): DiagnoseCheck {
  return { id: input.id, status: input.status, detail: input.detail, hint: input.hint ?? null };
}

/** The same reason for several checks that could not be made (e.g. an earlier fetch failed). */
export function unknownChecks(ids: readonly string[], detail: string): DiagnoseCheck[] {
  return ids.map((id) => check({ id, status: 'unknown', detail }));
}

/** concise: hints only on checks that are not ok. detailed: every hint. */
export function stripOkHints(
  checks: readonly DiagnoseCheck[],
  format: 'concise' | 'detailed',
): DiagnoseCheck[] {
  return format === 'detailed'
    ? [...checks]
    : checks.map((c) => (c.status === 'ok' ? { ...c, hint: null } : c));
}
