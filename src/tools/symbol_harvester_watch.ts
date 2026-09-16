import * as z from 'zod/v4';
import { ChainInfoSchema, NodeInfoSchema, UnlockedAccountSchema } from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { parseHeight } from '../domain/epoch.js';
import {
  diffKeys,
  type HarvesterState,
  HISTORY_WINDOW_DAYS,
  historyStats,
  MAX_SNAPSHOTS,
  normalizeKeys,
  resolveStateFile,
  type Snapshot,
  trimSnapshots,
} from '../domain/harvesterwatch.js';
import { formatInstantText } from '../domain/time.js';
import {
  readSnapshotFile,
  StateFileError,
  writeSnapshotFileAtomic,
} from '../state/snapshotfile.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';

const inputSchema = z.object({
  mode: z
    .enum(['compare', 'compare_and_save', 'save_only'])
    .default('compare_and_save')
    .describe(
      'compare: read the previous snapshot and report the difference, write nothing. compare_and_save (default): compare, then store the current list as the newest snapshot. save_only: store without comparing. Snapshots live under SYMBOL_STATE_DIR; without it every mode reports the current list only.',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): counts plus the added and removed keys. detailed: also the full current key list and one row per stored snapshot in the window.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  mode: z.enum(['compare', 'compare_and_save', 'save_only']),
  node: z.object({ host: z.string(), publicKey: z.string() }),
  current: z.object({
    count: z.number(),
    takenAt: InstantSchema,
    height: z.number(),
    keys: nullable(
      z.array(z.string()),
      'Unlocked remote (linked) public keys, ascending; null in concise format.',
    ),
  }),
  comparison: nullable(
    z.object({
      previousTakenAt: InstantSchema,
      previousHeight: z.number(),
      previousCount: z.number(),
      added: z.array(z.string()),
      removed: z.array(z.string()),
      unchangedCount: z.number(),
      deltaCount: z.number(),
    }),
    'Difference against the newest stored snapshot; null when there is none, SYMBOL_STATE_DIR is unset, or mode is save_only.',
  ),
  history: nullable(
    z.object({
      snapshots: z.number(),
      oldestTakenAt: InstantSchema,
      min: z.number(),
      max: z.number(),
      average: z.number(),
      entries: nullable(
        z.array(z.object({ takenAt: InstantSchema, height: z.number(), count: z.number() })),
        'One row per stored snapshot in the window, newest first; null in concise format.',
      ),
    }),
    `Unlocked counts over the snapshots stored in the last ${HISTORY_WINDOW_DAYS} days (before this call); null when there are none, SYMBOL_STATE_DIR is unset, or mode is save_only.`,
  ),
  saved: z.boolean(),
  stateFile: nullable(
    z.string(),
    'Absolute path of the snapshot file; null when SYMBOL_STATE_DIR is unset.',
  ),
  notes: z.array(z.string()),
});

const NOTES = [
  "The unlocked list (/node/unlockedaccount) is the node's own report and is not backed by chain data.",
  'Keys are remote (linked) harvesting keys; the delegators’ main accounts cannot be identified from them.',
  'Right after a node restart the unlocked count can be 0 or low for a while, until delegations are re-activated.',
];

const UNSET_NOTE =
  'SYMBOL_STATE_DIR is not set, so snapshots are not stored and no comparison is possible. Set it to an absolute directory (created on first save, mode 0700) to compare against the previous call.';

function countText(n: number): string {
  return `${formatInteger(n)} unlocked harvester${n === 1 ? '' : 's'}`;
}

export const harvesterWatchTool = defineTool({
  name: 'symbol_harvester_watch',
  title: 'Symbol unlocked harvester watch',
  description:
    'Compare the delegated harvesters currently unlocked on the configured node (/node/unlockedaccount) with the previous call: which remote keys were added or removed, the count delta, and min / max / average over the snapshots of the last 30 days. Snapshots (public keys, heights and times only) are kept in one file per node under SYMBOL_STATE_DIR; without that variable the tool reports the current list and says no comparison is possible. Mode compare reads only, compare_and_save (default) also stores the current list, save_only stores without comparing. Use it after a node migration ("did the delegators come back?") and for monthly churn. symbol_harvesting_status shows the current list only.',
  inputSchema,
  outputSchema,
  run: async (ctx: AppContext, { mode, format }) => {
    const [info, unlocked, chain] = await Promise.all([
      ctx.rest.get('/node/info', NodeInfoSchema),
      ctx.rest.get('/node/unlockedaccount', UnlockedAccountSchema),
      ctx.rest.get('/chain/info', ChainInfoSchema),
    ]);
    const host = ctx.rest.host;
    const nodePublicKey = info.nodePublicKey?.toUpperCase();
    if (!nodePublicKey) {
      throw new ToolInputError(
        `${host} does not report a nodePublicKey in /node/info, so snapshots cannot be keyed to this node. Point SYMBOL_NODE_URL at a node whose REST gateway reports nodePublicKey, or use symbol_harvesting_status for the current list without a comparison.`,
      );
    }
    const keys = normalizeKeys(unlocked.unlockedAccount);
    const height = parseHeight(chain.height);
    const now = ctx.now();
    const notes = [...NOTES];
    const current = {
      count: keys.length,
      takenAt: ctx.instant(now),
      height,
      keys: format === 'detailed' ? keys : null,
    };
    const base = { network: ctx.network.name, mode, node: { host, publicKey: nodePublicKey } };

    if (!ctx.config.stateDir) {
      notes.push(UNSET_NOTE);
      return {
        summary: `${countText(keys.length)} on ${host}. SYMBOL_STATE_DIR is not set, so no comparison.`,
        ...base,
        current,
        comparison: null,
        history: null,
        saved: false,
        stateFile: null,
        notes,
      };
    }

    const target = resolveStateFile(ctx.config.stateDir, nodePublicKey);
    const read = await readSnapshotFile(target.file);
    const willSave = mode !== 'compare';
    let state: HarvesterState | null = read.state;
    let baselineReason: string | null = null;
    if (read.corrupt) {
      baselineReason = `Could not read ${target.file} (${read.reason}); treating this call as the baseline.`;
    } else if (state && state.nodePublicKey !== nodePublicKey) {
      baselineReason = `${target.file} belongs to another node key; treating this call as the baseline.`;
      state = null;
    }
    if (baselineReason) {
      state = null;
      notes.push(
        `${baselineReason} ${willSave ? 'The file was overwritten.' : `Nothing was written in mode ${mode}.`}`,
      );
    }

    const previous: Snapshot | undefined = state?.snapshots[0];
    const compare = mode !== 'save_only';
    const comparison =
      compare && previous
        ? {
            previousTakenAt: ctx.instant(new Date(previous.takenAt)),
            previousHeight: previous.height,
            previousCount: previous.keys.length,
            ...diffKeys(previous.keys, keys),
            deltaCount: keys.length - previous.keys.length,
          }
        : null;
    const stats = compare && state ? historyStats(state.snapshots, now) : null;
    const history = stats
      ? {
          snapshots: stats.snapshots,
          oldestTakenAt: ctx.instant(new Date(stats.oldestTakenAt)),
          min: stats.min,
          max: stats.max,
          average: stats.average,
          entries:
            format === 'detailed' && state
              ? state.snapshots
                  .filter(
                    (s) =>
                      Date.parse(s.takenAt) >= now.getTime() - HISTORY_WINDOW_DAYS * 86_400_000,
                  )
                  .map((s) => ({
                    takenAt: ctx.instant(new Date(s.takenAt)),
                    height: s.height,
                    count: s.keys.length,
                  }))
              : null,
        }
      : null;

    let saved = false;
    let saveErrorCode: string | null = null;
    let storedCount = state?.snapshots.length ?? 0;
    if (willSave) {
      const next: HarvesterState = {
        version: 1,
        nodePublicKey,
        snapshots: trimSnapshots([
          { takenAt: now.toISOString(), height, keys },
          ...(state?.snapshots ?? []),
        ]),
      };
      try {
        await writeSnapshotFileAtomic(target, next);
        saved = true;
        storedCount = next.snapshots.length;
      } catch (err) {
        // In compare_and_save the comparison is still the answer; save_only has nothing else.
        if (!(err instanceof StateFileError) || mode === 'save_only') throw err;
        saveErrorCode = err.code;
        notes.push(
          `Snapshot not saved: could not ${err.operation} ${err.path} (${err.code}). Check that SYMBOL_STATE_DIR is writable by the server process.`,
        );
      }
    }
    if (storedCount >= MAX_SNAPSHOTS) {
      notes.push(
        `The file keeps the newest ${MAX_SNAPSHOTS} snapshots; older ones are dropped on save.`,
      );
    }

    const head = `${countText(keys.length)} on ${host}`;
    const savedText = !willSave
      ? ''
      : saved
        ? ` Snapshot saved (${formatInteger(storedCount)} stored).`
        : ` Snapshot NOT saved (${saveErrorCode ?? 'error'}).`;
    let summary: string;
    if (mode === 'save_only') {
      summary = `${head}.${savedText}`;
    } else if (comparison) {
      const when = formatInstantText(comparison.previousTakenAt);
      const change =
        comparison.added.length === 0 && comparison.removed.length === 0
          ? `, unchanged since ${when}.`
          : ` (was ${formatInteger(comparison.previousCount)} on ${when}): +${comparison.added.length} -${comparison.removed.length}.`;
      summary = `${head}${change}${savedText}`;
    } else {
      const why = baselineReason ? 'Previous snapshot unusable' : 'No previous snapshot';
      summary = `${head}. ${why}${willSave ? `; baseline${savedText.replace(' Snapshot', '')}` : '; nothing saved in mode compare.'}`;
    }

    return {
      summary,
      ...base,
      current,
      comparison,
      history,
      saved,
      stateFile: target.file,
      notes,
    };
  },
});
