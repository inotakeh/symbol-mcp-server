/**
 * Pure rules behind symbol_harvester_watch: the snapshot file format, key-set differences,
 * history statistics and the path containment rule for the state file. No I/O here
 * (src/state/snapshotfile.ts does the reading and writing).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as z from 'zod/v4';
import { roundTo } from './time.js';

/** Snapshots kept per node file (newest first); older ones are dropped on save. */
export const MAX_SNAPSHOTS = 60;
/** Window of the history statistics. */
export const HISTORY_WINDOW_DAYS = 30;
export const STATE_FILE_PREFIX = 'harvesters-';
export const STATE_FILE_VERSION = 1;
const MS_PER_DAY = 86_400_000;

const UpperHex64 = z.string().regex(/^[0-9A-F]{64}$/, 'expected an upper-case 64-hex public key');

export const SnapshotSchema = z.object({
  /** ISO 8601 UTC (Date.toISOString()). */
  takenAt: z.iso.datetime(),
  height: z.number().int().nonnegative(),
  /** Remote (linked) public keys unlocked on the node, upper-case, ascending, unique. */
  keys: z.array(UpperHex64),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * The state file: one per node (keyed by nodePublicKey). No length cap on `snapshots` so a
 * hand-edited longer file still loads; it is trimmed to MAX_SNAPSHOTS on the next save.
 */
export const HarvesterStateSchema = z.object({
  version: z.literal(STATE_FILE_VERSION),
  nodePublicKey: UpperHex64,
  /** Newest first. */
  snapshots: z.array(SnapshotSchema),
});
export type HarvesterState = z.infer<typeof HarvesterStateSchema>;

/** Upper-case, de-duplicated, ascending: the canonical form stored and compared. */
export function normalizeKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((k) => k.trim().toUpperCase()))].sort();
}

export interface KeyDiff {
  /** Present now, absent before (ascending). */
  readonly added: string[];
  /** Present before, absent now (ascending). */
  readonly removed: string[];
  readonly unchangedCount: number;
}

export function diffKeys(prev: readonly string[], curr: readonly string[]): KeyDiff {
  const before = new Set(normalizeKeys(prev));
  const now = new Set(normalizeKeys(curr));
  const added = [...now].filter((k) => !before.has(k)).sort();
  const removed = [...before].filter((k) => !now.has(k)).sort();
  return { added, removed, unchangedCount: [...now].filter((k) => before.has(k)).length };
}

export interface HistoryStats {
  /** Snapshots inside the window. */
  readonly snapshots: number;
  readonly oldestTakenAt: string;
  readonly min: number;
  readonly max: number;
  /** Mean unlocked count, one decimal. */
  readonly average: number;
}

/**
 * Statistics over the stored snapshots taken within the last `windowDays` (future-dated entries
 * are kept: a clock that went backwards should not hide history). Null when none is in the window.
 */
export function historyStats(
  snapshots: readonly Snapshot[],
  now: Date,
  windowDays: number = HISTORY_WINDOW_DAYS,
): HistoryStats | null {
  const cutoffMs = now.getTime() - windowDays * MS_PER_DAY;
  const inWindow = snapshots.filter((s) => Date.parse(s.takenAt) >= cutoffMs);
  if (inWindow.length === 0) return null;
  const counts = inWindow.map((s) => s.keys.length);
  const oldest = inWindow.reduce((a, b) =>
    Date.parse(a.takenAt) <= Date.parse(b.takenAt) ? a : b,
  );
  return {
    snapshots: inWindow.length,
    oldestTakenAt: oldest.takenAt,
    min: Math.min(...counts),
    max: Math.max(...counts),
    average: roundTo(counts.reduce((a, b) => a + b, 0) / counts.length, 1),
  };
}

/** Keeps the first `max` entries of a newest-first list. */
export function trimSnapshots(list: readonly Snapshot[], max: number = MAX_SNAPSHOTS): Snapshot[] {
  return list.slice(0, max);
}

/** `harvesters-<first 16 hex of the node public key>.json`; the key must be 64 hex characters. */
export function stateFileName(nodePublicKey: string): string {
  const key = nodePublicKey.trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(key)) throw new Error('nodePublicKey must be 64 hex characters');
  return `${STATE_FILE_PREFIX}${key.slice(0, 16)}.json`;
}

/**
 * Throws unless `target` is strictly inside `dir` (both already resolved): rejects the directory
 * itself, `..` escapes, absolute paths elsewhere and the `/a/b` versus `/a/bb` prefix trap.
 */
export function assertInsideDir(dir: string, target: string): void {
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !target.startsWith(dir + sep)) {
    throw new Error(`refusing to write outside the state directory: ${target}`);
  }
}

export interface StateFileTarget {
  /** Resolved state directory. */
  readonly dir: string;
  /** Resolved absolute path of the node's snapshot file, inside `dir`. */
  readonly file: string;
}

/** Resolves the state directory and the node's file inside it, and proves the containment. */
export function resolveStateFile(stateDir: string, nodePublicKey: string): StateFileTarget {
  const dir = resolve(stateDir);
  const file = resolve(dir, stateFileName(nodePublicKey));
  assertInsideDir(dir, file);
  return { dir, file };
}
