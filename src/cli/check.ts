/**
 * `symbol-mcp-server check`: one health verdict for cron, built only from what the existing tools
 * already decide. Each item calls a tool's `run` directly (no MCP transport, no result shaping)
 * and re-reads its output as ok / warn / fail; no threshold of any tool is changed or duplicated
 * here. Nothing is sent anywhere: cron's MAILTO does the notifying.
 *
 * This directory must stay free of MCP SDK imports so the CLI can move to its own package later
 * (test/unit/cli-check.test.ts checks the import lines).
 */
import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import type { AppContext } from '../context.js';
import { describeSignedStages } from '../domain/finality.js';
import { sanitizeUntrusted } from '../domain/sanitize.js';
import type { Instant } from '../domain/time.js';
import { formatInstantText } from '../domain/time.js';
import { hasSuccessorKey, RENEWAL_WINDOW_END_DAYS } from '../domain/voting.js';
import { describeError, maskIdentifier, ToolInputError } from '../tools/_shared.js';
import { InstantSchema } from '../tools/_transactions.js';
import {
  finalityParticipationTool,
  ProofUnavailableError,
  UNAVAILABLE_NOTE,
} from '../tools/symbol_finality_participation.js';
import {
  harvesterWatchTool,
  NOT_SAVED_NOTE_PREFIX,
  RESTART_NOTE,
  UNSET_NOTE,
} from '../tools/symbol_harvester_watch.js';
import { nodeHealthTool } from '../tools/symbol_node_health.js';
import { versionDriftTool } from '../tools/symbol_version_drift.js';
import { votingKeyStatusTool } from '../tools/symbol_voting_key_status.js';

export const DEFAULT_WARN_DAYS = 14;
export const MIN_WARN_DAYS = 1;
export const MAX_WARN_DAYS = 120;
export const DEFAULT_TIME_LIMIT_MS = 120_000;

/** Fixed order of the report. */
export const CHECK_IDS = [
  'node_health',
  'version_drift',
  'harvester_watch',
  'voting_key_status',
  'finality_participation',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type CheckItemStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type CheckVerdict = 'ok' | 'warn' | 'fail' | 'error';
export type CheckExitCode = 0 | 1 | 2 | 3;

export interface CheckItem {
  readonly id: CheckId;
  readonly status: CheckItemStatus;
  readonly detail: string;
  /** Taken from the tool's own output (a check hint, a warning, a note); never written here. */
  readonly hint: string | null;
}

export interface CheckOptions {
  readonly account: string | null;
  readonly warnDays: number;
  /** Upper bound for the whole run. Default 120 s; not a command-line flag. */
  readonly timeLimitMs?: number;
  /** One line per problem that is about the run itself (time limit, node unreachable). */
  readonly onDiagnostic?: (line: string) => void;
}

export interface CheckReport {
  readonly verdict: CheckVerdict;
  readonly exitCode: CheckExitCode;
  readonly node: { readonly host: string; readonly network: string };
  readonly checkedAt: Instant;
  readonly checks: readonly CheckItem[];
  readonly warnDays: number;
  /** Resolved base32 address; the masked argument when it could not be resolved; null without --account. */
  readonly account: string | null;
}

export const CheckReportSchema = z.object({
  verdict: z.enum(['ok', 'warn', 'fail', 'error']),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  node: z.object({ host: z.string(), network: z.string() }),
  checkedAt: InstantSchema,
  checks: z.array(
    z.object({
      id: z.enum(CHECK_IDS),
      status: z.enum(['ok', 'warn', 'fail', 'skip']),
      detail: z.string(),
      hint: z.union([z.string(), z.null()]),
    }),
  ),
  warnDays: z.number(),
  account: z.union([z.string(), z.null()]),
});

// ---------------------------------------------------------------------------------------------
// Tool output -> check item. Pure; the views name only the fields that are read, so the full
// tool outputs are assignable and unit tests can pass small literals.
// ---------------------------------------------------------------------------------------------

type ItemBody = Omit<CheckItem, 'id'>;

export interface NodeHealthView {
  readonly verdict: 'healthy' | 'degraded' | 'unhealthy';
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly status: 'ok' | 'warn' | 'fail' | 'unknown';
    readonly detail: string;
    readonly hint: string | null;
  }>;
  readonly chain: { readonly height: number; readonly finalizedHeight: number } | null;
}

const HEALTH_STATUS: Record<NodeHealthView['verdict'], CheckItemStatus> = {
  healthy: 'ok',
  degraded: 'warn',
  unhealthy: 'fail',
};
const SEVERITY = { fail: 0, warn: 1, unknown: 2, ok: 3 } as const;

export function mapNodeHealth(output: NodeHealthView): ItemBody {
  const status = HEALTH_STATUS[output.verdict];
  const notOk = output.checks.filter((c) => c.status !== 'ok');
  // Most severe first; Array.prototype.sort is stable, so the tool's fixed order breaks ties.
  const worst = [...notOk].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status])[0];
  if (!worst) {
    const lag = output.chain
      ? ` (finalization lag ${output.chain.height - output.chain.finalizedHeight} blocks)`
      : '';
    return { status, detail: `${output.verdict}${lag}`, hint: null };
  }
  const list = notOk.map((c) => `${c.id} ${c.status}`).join(', ');
  return { status, detail: `${output.verdict} (${list}). ${worst.detail}`, hint: worst.hint };
}

export interface VersionDriftView {
  readonly verdict: 'ok' | 'behind' | 'far_behind' | 'unknown';
  readonly summary: string;
}

const DRIFT_STATUS: Record<VersionDriftView['verdict'], CheckItemStatus> = {
  ok: 'ok',
  behind: 'warn',
  far_behind: 'fail',
  unknown: 'warn',
};
const DRIFT_SUMMARY_PREFIX = 'version drift: ';

export function mapVersionDrift(output: VersionDriftView): ItemBody {
  const [first = output.verdict, ...rest] = output.summary.split('\n');
  const detail = first.startsWith(DRIFT_SUMMARY_PREFIX)
    ? first.slice(DRIFT_SUMMARY_PREFIX.length)
    : first;
  // The tool puts its advice on the summary lines that start with "- ".
  const advice = rest.find((line) => line.startsWith('- '));
  return { status: DRIFT_STATUS[output.verdict], detail, hint: advice ? advice.slice(2) : null };
}

export interface HarvesterWatchView {
  readonly summary: string;
  readonly comparison: { readonly deltaCount: number } | null;
  readonly saved: boolean;
  readonly notes: readonly string[];
}

/** Always called with mode compare_and_save, where `saved: false` means the write failed. */
export function mapHarvesterWatch(output: HarvesterWatchView): ItemBody {
  const dropped = output.comparison !== null && output.comparison.deltaCount < 0;
  let hint: string | null = null;
  if (!output.saved) {
    hint = output.notes.find((n) => n.startsWith(NOT_SAVED_NOTE_PREFIX)) ?? null;
  } else if (dropped) {
    hint = output.notes.find((n) => n === RESTART_NOTE) ?? null;
  }
  return { status: dropped || !output.saved ? 'warn' : 'ok', detail: output.summary, hint };
}

/** An Instant as zod infers it from a tool's output schema (`local` may be present but undefined). */
interface InstantView {
  readonly utc: string;
  readonly local?: string | undefined;
}

function instantText(i: InstantView): string {
  return formatInstantText(i.local === undefined ? { utc: i.utc } : { utc: i.utc, local: i.local });
}

export interface VotingKeysView {
  readonly votingKeys: ReadonlyArray<{
    readonly publicKey: string;
    readonly status: 'expired' | 'active' | 'future';
    readonly startEpoch: number;
    readonly endEpoch: number;
    readonly remainingDays?: number | undefined;
    readonly expiresAt?: InstantView | undefined;
  }>;
  readonly warnings: readonly string[];
}

/**
 * fail at or inside the end of the tool's recommended renewal window (3 days) or without an
 * active key, warn within `warnDays`, ok otherwise; and ok whenever a successor key is already
 * registered without a gap (the tool's own "covered" rule), because the renewal is done.
 */
export function mapVotingKeys(output: VotingKeysView, warnDays: number): ItemBody {
  const active = output.votingKeys.filter((k) => k.status === 'active');
  const future = output.votingKeys.filter((k) => k.status === 'future');
  const key = [...active].sort((a, b) => (b.remainingDays ?? 0) - (a.remainingDays ?? 0))[0];
  if (!key) {
    const expired = output.votingKeys.length - future.length;
    return {
      status: 'fail',
      detail: `no active voting key (${output.votingKeys.length} registered: ${future.length} future, ${expired} expired)`,
      hint: output.warnings[0] ?? null,
    };
  }
  const days = key.remainingDays ?? 0;
  const prefix = key.publicKey.slice(0, 8);
  const when = key.expiresAt ? `, estimated ${instantText(key.expiresAt)}` : '';
  const base = `active key ${prefix}… expires in about ${days} days (epoch ${key.endEpoch}${when})`;
  if (hasSuccessorKey(key, future)) {
    return { status: 'ok', detail: `${base}; successor registered`, hint: null };
  }
  const status: CheckItemStatus =
    days <= RENEWAL_WINDOW_END_DAYS ? 'fail' : days <= warnDays ? 'warn' : 'ok';
  return {
    status,
    detail: base,
    hint: status === 'ok' ? null : (output.warnings.find((w) => w.includes(prefix)) ?? null),
  };
}

export interface FinalityView {
  readonly epochs: ReadonlyArray<{
    readonly epoch: number;
    readonly status: 'participated' | 'missed' | 'no_active_key' | 'unavailable';
    readonly stages?:
      | ReadonlyArray<{ readonly stageName: string; readonly participated: boolean }>
      | undefined;
  }>;
  readonly warning: string | null;
  readonly notes: readonly string[];
}

const FINALITY_STATUS: Record<FinalityView['epochs'][number]['status'], CheckItemStatus> = {
  participated: 'ok',
  missed: 'warn',
  no_active_key: 'fail',
  unavailable: 'warn',
};

/** Called with epochs 1, so the first (and only) entry is the latest finalized epoch. */
export function mapFinality(output: FinalityView): ItemBody {
  const latest = output.epochs[0];
  if (!latest || latest.status === 'unavailable') {
    return {
      status: 'warn',
      detail: latest ? `epoch ${latest.epoch}: proof unavailable` : 'proof unavailable',
      hint: output.notes.find((n) => n === UNAVAILABLE_NOTE) ?? null,
    };
  }
  let detail = `epoch ${latest.epoch}: ${latest.status.replaceAll('_', ' ')}`;
  // Stages are judged as a whole by the tool (a stage may span several message groups), so each
  // is named once: "signed prevote and precommit" / "signed prevote, not precommit".
  if (latest.status !== 'no_active_key' && latest.stages) {
    detail += ` (${describeSignedStages(latest.stages)})`;
  }
  return {
    status: FINALITY_STATUS[latest.status],
    detail,
    hint: latest.status === 'participated' ? null : output.warning,
  };
}

export interface ExitFlags {
  /** The time limit cut the run short: never better than warn. */
  readonly timedOut?: boolean;
  /** Every item that ran failed to reach the node: the check itself could not be made. */
  readonly nodeUnreachable?: boolean;
}

export function decideExit(
  checks: ReadonlyArray<{ readonly status: CheckItemStatus }>,
  flags: ExitFlags = {},
): { verdict: CheckVerdict; exitCode: CheckExitCode } {
  if (flags.nodeUnreachable) return { verdict: 'error', exitCode: 3 };
  if (checks.some((c) => c.status === 'fail')) return { verdict: 'fail', exitCode: 2 };
  if (flags.timedOut || checks.some((c) => c.status === 'warn')) {
    return { verdict: 'warn', exitCode: 1 };
  }
  return { verdict: 'ok', exitCode: 0 };
}

// ---------------------------------------------------------------------------------------------
// Running the items
// ---------------------------------------------------------------------------------------------

/** "What is wrong. How to fix it." -> the first sentence and the rest. */
function splitFirstSentence(message: string): { first: string; rest: string | null } {
  const at = message.indexOf('. ');
  if (at < 0) return { first: message, rest: null };
  return { first: message.slice(0, at + 1), rest: message.slice(at + 2) };
}

interface Failure {
  readonly body: ItemBody;
  /** The node could not be reached at all (as opposed to answering with an error). */
  readonly unreachable: boolean;
}

function describeFailure(id: CheckId, err: unknown, ctx: AppContext): Failure {
  if (err instanceof RestError) {
    const status = err.status ? ` ${err.status}` : '';
    return {
      body: {
        status: 'fail',
        detail: `could not run: ${err.kind}${status} on ${err.path}`,
        hint: describeError(err, ctx),
      },
      unreachable: err.kind === 'unreachable' || err.kind === 'timeout',
    };
  }
  if (err instanceof ToolInputError) {
    const { first, rest } = splitFirstSentence(err.message);
    // With epochs 1 the tool reports a missing proof as an error instead of status unavailable.
    const proofMissing = id === 'finality_participation' && err instanceof ProofUnavailableError;
    return {
      body: proofMissing
        ? { status: 'warn', detail: first, hint: UNAVAILABLE_NOTE }
        : { status: 'fail', detail: first, hint: rest },
      unreachable: false,
    };
  }
  // describeError writes the details of an unexpected error to stderr and returns a generic text.
  return {
    body: {
      status: 'fail',
      detail: 'could not run: internal error',
      hint: describeError(err, ctx),
    },
    unreachable: false,
  };
}

type Raced<T> = { readonly done: true; readonly value: T } | { readonly done: false };

/** Resolves `{ done: false }` after `ms`; a late rejection of `work` is swallowed, not unhandled. */
function withinTimeLimit<T>(work: Promise<T>, ms: number): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ done: false }), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ done: true, value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface Step {
  readonly id: CheckId;
  /** Reason not to run at all, or null. */
  readonly skip: string | null;
  readonly run: () => Promise<ItemBody>;
}

const NO_ACCOUNT =
  'no --account given; pass --account <address|publicKey|namespace> to check the voting key';

export async function runCheck(ctx: AppContext, options: CheckOptions): Promise<CheckReport> {
  const { account, warnDays } = options;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const limitText =
    timeLimitMs >= 1000
      ? `time limit of ${Math.round(timeLimitMs / 1000)} s`
      : `time limit of ${timeLimitMs} ms`;
  // Filled by the voting key step (an object, because the assignment happens in a closure).
  const resolved: { address: string | null } = { address: null };

  const steps: readonly Step[] = [
    {
      id: 'node_health',
      skip: null,
      run: async () => mapNodeHealth(await nodeHealthTool.run(ctx, { format: 'concise' })),
    },
    {
      id: 'version_drift',
      skip: null,
      run: async () => mapVersionDrift(await versionDriftTool.run(ctx, { format: 'concise' })),
    },
    {
      id: 'harvester_watch',
      skip: ctx.config.stateDir ? null : UNSET_NOTE,
      run: async () =>
        mapHarvesterWatch(
          await harvesterWatchTool.run(ctx, { mode: 'compare_and_save', format: 'concise' }),
        ),
    },
    {
      id: 'voting_key_status',
      skip: account === null ? NO_ACCOUNT : null,
      run: async () => {
        const output = await votingKeyStatusTool.run(ctx, { account: account ?? '' });
        resolved.address = output.account.address;
        return mapVotingKeys(output, warnDays);
      },
    },
    {
      id: 'finality_participation',
      skip: account === null ? NO_ACCOUNT : null,
      run: async () =>
        mapFinality(
          await finalityParticipationTool.run(ctx, {
            account: account ?? '',
            epochs: 1,
            // detailed: the stages are listed for a participated epoch too (the detail names them).
            format: 'detailed',
          }),
        ),
    },
  ];

  const started = performance.now();
  const checks: CheckItem[] = [];
  let ran = 0;
  let unreachable = 0;
  let cutShort = 0;
  for (const step of steps) {
    if (step.skip !== null) {
      checks.push({ id: step.id, status: 'skip', detail: step.skip, hint: null });
      continue;
    }
    const remainingMs = timeLimitMs - (performance.now() - started);
    if (cutShort > 0 || remainingMs <= 0) {
      cutShort++;
      checks.push({
        id: step.id,
        status: 'skip',
        detail: `${limitText} reached before this check ran`,
        hint: null,
      });
      continue;
    }
    try {
      const raced = await withinTimeLimit(step.run(), remainingMs);
      if (raced.done) {
        ran++;
        checks.push({ id: step.id, ...raced.value });
      } else {
        cutShort++;
        checks.push({
          id: step.id,
          status: 'skip',
          detail: `${limitText} reached while this check was running`,
          hint: null,
        });
      }
    } catch (err) {
      ran++;
      const failure = describeFailure(step.id, err, ctx);
      if (failure.unreachable) unreachable++;
      checks.push({ id: step.id, ...failure.body });
    }
  }

  const nodeUnreachable = ran > 0 && unreachable === ran;
  if (cutShort > 0) {
    options.onDiagnostic?.(
      `${limitText} reached: ${cutShort} check(s) skipped, so the result is at best WARN. ${ctx.rest.host} is answering slowly; run the command by hand to see which check hangs.`,
    );
  }
  if (nodeUnreachable) {
    options.onDiagnostic?.(
      `${ctx.rest.host} stopped answering after start-up, so no check could be made. Verify that the node is up and reachable from this machine (SYMBOL_NODE_URL).`,
    );
  }

  const shownAccount =
    account === null
      ? null
      : (resolved.address ?? maskIdentifier(sanitizeUntrusted(account.trim(), 64)));
  return {
    ...decideExit(checks, { timedOut: cutShort > 0, nodeUnreachable }),
    node: { host: ctx.rest.host, network: ctx.network.name },
    checkedAt: ctx.instant(ctx.now()),
    checks,
    warnDays,
    account: shownAccount,
  };
}
