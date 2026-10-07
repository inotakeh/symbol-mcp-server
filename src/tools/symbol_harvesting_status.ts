import * as z from 'zod/v4';
import {
  ChainInfoSchema,
  MosaicInfoSchema,
  NodeInfoSchema,
  UnlockedAccountSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { formatAmount } from '../domain/amount.js';
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
import { mosaicLabel } from '../domain/quote.js';
import { formatInstantText } from '../domain/time.js';
import {
  readSnapshotFile,
  StateFileError,
  writeSnapshotFileAtomic,
} from '../state/snapshotfile.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';

const MODES = ['current', 'compare', 'compare_and_save', 'save_only'] as const;

const inputSchema = z.object({
  mode: z
    .enum(MODES)
    .default('current')
    .describe(
      'current (default): the list as it is now; no snapshot is read or written. compare: read the previous snapshot and report the difference, write nothing. compare_and_save: compare, then store the current list as the newest snapshot. save_only: store without comparing. Snapshots live under SYMBOL_STATE_DIR; without it these three modes report the current list only.',
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): the count and the limits, and in a comparison the added and removed keys. detailed: also the full current key list and one row per stored snapshot in the window.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  mode: z.enum(MODES),
  node: z.object({
    host: z.string(),
    nodePublicKey: nullable(
      z.string(),
      'nodePublicKey of the node (/node/info), which names its snapshot file; null when the node reports none (only mode current answers then).',
    ),
  }),
  current: z.object({
    count: z.number(),
    takenAt: InstantSchema,
    height: z.number(),
    keys: nullable(
      z.array(z.string()),
      'Unlocked remote (linked) public keys, ascending; null in concise format.',
    ),
  }),
  limits: z.object({
    minHarvesterBalance: z.string(),
    rawMinHarvesterBalance: z.string(),
    maxHarvesterBalance: z.string(),
    rawMaxHarvesterBalance: z.string(),
    harvestBeneficiaryPercentage: z.number(),
    harvestingMosaic: z.object({
      id: z.string(),
      alias: nullable(z.string(), 'Alias of the harvesting mosaic; null when none.'),
      divisibility: z.number(),
    }),
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
    'Difference against the newest stored snapshot; null when there is none, SYMBOL_STATE_DIR is unset, or mode is current or save_only.',
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
    `Unlocked counts over the snapshots stored in the last ${HISTORY_WINDOW_DAYS} days (before this call); null when there are none, SYMBOL_STATE_DIR is unset, or mode is current or save_only.`,
  ),
  saved: z.boolean(),
  stateFile: nullable(
    z.string(),
    'Absolute path of the snapshot file this call read or wrote; null in mode current and when SYMBOL_STATE_DIR is unset.',
  ),
  notes: z.array(z.string()),
});

/** Exported for the CLI check, which shows it as the hint when the count dropped. */
export const RESTART_NOTE =
  'Right after a node restart the unlocked count can be 0 or low for a while, until delegations are re-activated.';

const NOTES = [
  "The unlocked list (/node/unlockedaccount) is the node's own report and is not backed by chain data.",
  'Keys are remote (linked) harvesting keys; the delegators’ main accounts cannot be identified from them.',
  RESTART_NOTE,
];

/** Added in mode current, where nothing is compared: how to ask for the comparison. */
const COMPARE_NOTE =
  'Mode current compares nothing. Call again with mode "compare" to see how the list changed since the last stored snapshot, or "compare_and_save" to store the current list as well; both need SYMBOL_STATE_DIR.';

/** Prefix of the note added when compare_and_save could not write the snapshot file. */
export const NOT_SAVED_NOTE_PREFIX = 'Snapshot not saved:';

export const UNSET_NOTE =
  'SYMBOL_STATE_DIR is not set, so snapshots are not stored and no comparison is possible. Set it to an absolute directory (created on first save, mode 0700) to compare against the previous call.';

function countText(n: number): string {
  return `${formatInteger(n)} unlocked harvester${n === 1 ? '' : 's'}`;
}

export const harvestingStatusTool = defineTool({
  name: 'symbol_harvesting_status',
  title: 'Symbol harvesting status',
  description:
    'List the delegated harvesters unlocked on the configured node right now (/node/unlockedaccount): how many there are, how the list changed since the last stored snapshot, and the network\'s harvesting limits. For whether one account\'s delegated harvesting works and where it stops, use symbol_delegation_diagnose; for harvesting rewards, symbol_harvesting_income. Mode current (default) reads the node only and gives the count and the limits (minHarvesterBalance, maxHarvesterBalance, harvestBeneficiaryPercentage); the keys themselves come with format detailed. The other modes use one snapshot file per node under SYMBOL_STATE_DIR (public keys, heights and times only): compare reports which remote keys were added or removed, the count delta and min / max / average over the snapshots of the last 30 days, and writes nothing; compare_and_save also stores the current list; save_only stores without comparing. Without SYMBOL_STATE_DIR they report the current list and say no comparison is possible. Use mode compare after a node migration ("did the delegators come back?") and compare_and_save for monthly churn.',
  inputSchema,
  outputSchema,
  untrustedText: true,
  run: async (ctx: AppContext, { mode, format }, text) => {
    const [info, unlocked, chain, { properties, currency }] = await Promise.all([
      ctx.rest.get('/node/info', NodeInfoSchema),
      ctx.rest.get('/node/unlockedaccount', UnlockedAccountSchema),
      ctx.rest.get('/chain/info', ChainInfoSchema),
      ctx.getNetworkData(),
    ]);
    const host = ctx.rest.host;
    const nodePublicKey = info.nodePublicKey?.toUpperCase() ?? null;

    let harvestingMosaic: { id: string; alias: string | null; divisibility: number };
    if (properties.harvestingMosaicId === currency.mosaicId) {
      harvestingMosaic = {
        id: properties.harvestingMosaicId,
        alias: text.useOrNull(currency.alias),
        divisibility: currency.divisibility,
      };
    } else {
      const [mosaic, aliases] = await Promise.all([
        ctx.rest.get(`/mosaics/${properties.harvestingMosaicId}`, MosaicInfoSchema),
        ctx.resolveMosaicAliases([properties.harvestingMosaicId]),
      ]);
      harvestingMosaic = {
        id: properties.harvestingMosaicId,
        alias: text.useOrNull(aliases.get(properties.harvestingMosaicId)),
        divisibility: mosaic.mosaic.divisibility,
      };
    }
    const div = harvestingMosaic.divisibility;
    const limits = {
      minHarvesterBalance: formatAmount(properties.minHarvesterBalance, div),
      rawMinHarvesterBalance: properties.minHarvesterBalance.toString(),
      maxHarvesterBalance: formatAmount(properties.maxHarvesterBalance, div),
      rawMaxHarvesterBalance: properties.maxHarvesterBalance.toString(),
      harvestBeneficiaryPercentage: properties.harvestBeneficiaryPercentage,
      harvestingMosaic,
    };

    const keys = normalizeKeys(unlocked.unlockedAccount);
    const height = parseHeight(chain.height);
    const now = ctx.now();
    const notes = [...NOTES];
    const head = `${countText(keys.length)} on ${host}`;
    // The same fields in every mode; a mode decides only which of the snapshot fields are null.
    const base = {
      network: ctx.network.name,
      mode,
      node: { host, nodePublicKey },
      current: {
        count: keys.length,
        takenAt: ctx.instant(now),
        height,
        keys: format === 'detailed' ? keys : null,
      },
      limits,
    };

    if (mode === 'current') {
      // No snapshot file is looked at, so the node needs no nodePublicKey to name one.
      notes.push(COMPARE_NOTE);
      // The summary quotes an alias outside the namespace grammar (domain/quote.ts).
      const unit = mosaicLabel(harvestingMosaic.alias, harvestingMosaic.id);
      return {
        summary: [
          `${head}.`,
          `Harvesting requires a balance from ${limits.minHarvesterBalance} to ${limits.maxHarvesterBalance} ${unit} (both inclusive) and non-zero importance; the node keeps ${properties.harvestBeneficiaryPercentage}% of block rewards.`,
        ].join('\n'),
        ...base,
        comparison: null,
        history: null,
        saved: false,
        stateFile: null,
        notes,
      };
    }

    if (nodePublicKey === null) {
      throw new ToolInputError(
        `${host} does not report a nodePublicKey in /node/info, so snapshots cannot be keyed to this node. Point SYMBOL_NODE_URL at a node whose REST gateway reports nodePublicKey, or call symbol_harvesting_status with mode "current" (the default) for the current list without a comparison.`,
      );
    }

    if (!ctx.config.stateDir) {
      notes.push(UNSET_NOTE);
      return {
        summary: `${head}. SYMBOL_STATE_DIR is not set, so no comparison.`,
        ...base,
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
          `${NOT_SAVED_NOTE_PREFIX} could not ${err.operation} ${err.path} (${err.code}). Check that SYMBOL_STATE_DIR is writable by the server process.`,
        );
      }
    }
    if (storedCount >= MAX_SNAPSHOTS) {
      notes.push(
        `The file keeps the newest ${MAX_SNAPSHOTS} snapshots; older ones are dropped on save.`,
      );
    }

    // One line, as the check command prints it for its harvester_watch item: the limits are in
    // `limits` and are spelled out in the summary of mode current only.
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
      comparison,
      history,
      saved,
      stateFile: target.file,
      notes,
    };
  },
});
