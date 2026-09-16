import { createHash } from 'node:crypto';
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertInsideDir,
  diffKeys,
  HarvesterStateSchema,
  historyStats,
  MAX_SNAPSHOTS,
  normalizeKeys,
  resolveStateFile,
  type Snapshot,
  stateFileName,
  trimSnapshots,
} from '../../src/domain/harvesterwatch.js';

const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();
const A = H('fixture:harvester-02');
const B = H('fixture:harvester-03');
const C = H('fixture:harvester-04');
const D = H('fixture:harvester-05');
const E = H('fixture:harvester-06');
const NODE_KEY = H('fixture:node-key');
const NOW = new Date('2026-09-10T03:05:00.000Z');
const DAY = 86_400_000;

function snap(daysAgo: number, count: number): Snapshot {
  return {
    takenAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    height: 5_000_000 + count,
    keys: Array.from({ length: count }, (_, i) => H(`fixture:key-${i}`)).sort(),
  };
}

describe('normalizeKeys / diffKeys', () => {
  it('upper-cases, de-duplicates and sorts', () => {
    expect(normalizeKeys([B.toLowerCase(), A, B, ` ${A} `])).toEqual([A, B].sort());
  });
  it('computes added, removed and unchanged with ascending order', () => {
    const sorted = [A, B, C, D, E].sort() as [string, string, string, string, string];
    const [a, b, c, d, e] = sorted;
    expect(diffKeys([a, b, c], [e, d, c, b])).toEqual({
      added: [d, e],
      removed: [a],
      unchangedCount: 2,
    });
  });
  it('handles identical, empty and all-new lists', () => {
    expect(diffKeys([A, B], [B, A])).toEqual({ added: [], removed: [], unchangedCount: 2 });
    expect(diffKeys([], [])).toEqual({ added: [], removed: [], unchangedCount: 0 });
    expect(diffKeys([], [A])).toEqual({ added: [A], removed: [], unchangedCount: 0 });
    expect(diffKeys([A], [])).toEqual({ added: [], removed: [A], unchangedCount: 0 });
  });
});

describe('historyStats', () => {
  it('summarises the snapshots inside the window', () => {
    const stats = historyStats([snap(1, 15), snap(10, 18), snap(40, 30)], NOW);
    expect(stats).toEqual({
      snapshots: 2,
      oldestTakenAt: snap(10, 18).takenAt,
      min: 15,
      max: 18,
      average: 16.5,
    });
  });
  it('includes the window boundary and future-dated entries, returns null when empty', () => {
    expect(historyStats([snap(30, 5)], NOW)?.snapshots).toBe(1);
    expect(historyStats([snap(-1, 5)], NOW)?.snapshots).toBe(1);
    expect(historyStats([snap(31, 5)], NOW)).toBeNull();
    expect(historyStats([], NOW)).toBeNull();
  });
});

describe('trimSnapshots', () => {
  it('keeps the newest entries only', () => {
    const list = Array.from({ length: MAX_SNAPSHOTS + 1 }, (_, i) => snap(i, i));
    const trimmed = trimSnapshots(list);
    expect(trimmed).toHaveLength(MAX_SNAPSHOTS);
    expect(trimmed[0]).toEqual(list[0]);
    expect(trimmed.some((s) => s.keys.length === MAX_SNAPSHOTS)).toBe(false);
    expect(trimSnapshots(list.slice(0, 3))).toHaveLength(3);
    expect(trimSnapshots([])).toEqual([]);
  });
});

describe('stateFileName / assertInsideDir / resolveStateFile', () => {
  it('names the file after the first 16 hex characters of the node key', () => {
    expect(stateFileName(NODE_KEY)).toBe(`harvesters-${NODE_KEY.slice(0, 16)}.json`);
    expect(stateFileName(NODE_KEY.toLowerCase())).toBe(stateFileName(NODE_KEY));
    expect(() => stateFileName(NODE_KEY.slice(1))).toThrow();
    expect(() => stateFileName('../x')).toThrow();
    expect(() => stateFileName(`${NODE_KEY.slice(0, 63)}G`)).toThrow();
  });
  it('accepts only targets strictly inside the directory', () => {
    const dir = `${sep}a${sep}b`;
    expect(() => assertInsideDir(dir, `${dir}${sep}x.json`)).not.toThrow();
    expect(() => assertInsideDir(dir, dir)).toThrow(/outside/);
    expect(() => assertInsideDir(dir, `${sep}a${sep}c`)).toThrow(/outside/);
    expect(() => assertInsideDir(dir, `${sep}etc${sep}x`)).toThrow(/outside/);
    expect(() => assertInsideDir(dir, `${sep}a${sep}bb${sep}x`)).toThrow(/outside/);
  });
  it('resolves the directory and the file, normalising .. segments', () => {
    const target = resolveStateFile(`${sep}tmp${sep}x${sep}..${sep}y${sep}`, NODE_KEY);
    expect(target.dir).toBe(`${sep}tmp${sep}y`);
    expect(target.file).toBe(`${sep}tmp${sep}y${sep}${stateFileName(NODE_KEY)}`);
    expect(() => resolveStateFile(`${sep}tmp`, 'nope')).toThrow();
  });
});

describe('HarvesterStateSchema', () => {
  it('accepts the documented shape and rejects deviations', () => {
    const valid = { version: 1, nodePublicKey: NODE_KEY, snapshots: [snap(1, 2)] };
    expect(HarvesterStateSchema.safeParse(valid).success).toBe(true);
    expect(HarvesterStateSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
    expect(
      HarvesterStateSchema.safeParse({ ...valid, nodePublicKey: NODE_KEY.toLowerCase() }).success,
    ).toBe(false);
    expect(
      HarvesterStateSchema.safeParse({
        ...valid,
        snapshots: [{ ...snap(1, 2), takenAt: 'yesterday' }],
      }).success,
    ).toBe(false);
    expect(
      HarvesterStateSchema.safeParse({ ...valid, snapshots: [{ ...snap(1, 2), height: -1 }] })
        .success,
    ).toBe(false);
  });
});
