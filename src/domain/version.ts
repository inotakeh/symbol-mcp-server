/**
 * Node version decoding and comparison. `/node/info` returns the version as a 32-bit integer
 * whose bytes are major.minor.patch.build from the most significant byte:
 * 16777993 = 0x01000309 -> "1.0.3.9". Versions are compared component by component, never as
 * strings ("1.0.3.10" is newer than "1.0.3.9").
 */
import { roundTo } from './time.js';

export function decodeVersion(version: number): string {
  if (!Number.isInteger(version) || version < 0 || version > 0xffffffff) {
    throw new Error(`invalid packed version: ${version}`);
  }
  const major = (version >>> 24) & 0xff;
  const minor = (version >>> 16) & 0xff;
  const patch = (version >>> 8) & 0xff;
  const build = version & 0xff;
  return `${major}.${minor}.${patch}.${build}`;
}

/** "1.0.3.10" -> [1, 0, 3, 10]. Accepts one or more dot-separated decimal components. */
export function parseVersion(version: string): number[] {
  if (!/^\d+(\.\d+)*$/.test(version)) throw new Error(`invalid version string: ${version}`);
  return version.split('.').map((part) => Number(part));
}

/** Numeric comparison per component; missing components count as 0 ("1.0.3" equals "1.0.3.0"). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export interface VersionBucket {
  readonly version: string;
  readonly count: number;
  /** count / size, rounded to 4 decimals. */
  readonly share: number;
}

export interface VersionDistribution {
  readonly size: number;
  /** Sorted by count descending, then version descending. */
  readonly distribution: readonly VersionBucket[];
  /** The most common version; on a tie the newest of the tied versions. Null when the sample is empty. */
  readonly majorityVersion: string | null;
  /** Share of the sample running a version newer than `ownVersion`; null when the sample is empty. */
  readonly newerShare: number | null;
}

/**
 * Frequency distribution of the sampled versions. Ties are broken towards the newer version: a
 * tie means the network is mid-migration and the newer version is the one it converges on, so
 * the operator gets a warning they can dismiss rather than silence.
 */
export function versionDistribution(
  sample: readonly string[],
  ownVersion: string,
): VersionDistribution {
  const counts = new Map<string, number>();
  for (const version of sample) {
    parseVersion(version);
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  const size = sample.length;
  const distribution = [...counts.entries()]
    .map(([version, count]) => ({ version, count, share: roundTo(count / size, 4) }))
    .sort((a, b) => b.count - a.count || compareVersions(b.version, a.version));
  const newer = sample.filter((v) => compareVersions(v, ownVersion) > 0).length;
  return {
    size,
    distribution,
    majorityVersion: distribution[0]?.version ?? null,
    newerShare: size === 0 ? null : roundTo(newer / size, 4),
  };
}

/** Share of newer versions from which the node is considered far behind (policy, not a network constant). */
export const FAR_BEHIND_SHARE = 0.75;
/** Share of newer versions from which the node is considered behind even when its version is the mode. */
export const BEHIND_SHARE = 0.5;

export type VersionDriftVerdict = 'ok' | 'behind' | 'far_behind' | 'unknown';

/**
 * Empty sample -> unknown. newerShare >= 0.75 -> far_behind. Older than the majority, or
 * newerShare >= 0.5 (own version is still the mode but newer versions together dominate) ->
 * behind. Otherwise ok, including when the node is newer than the majority.
 */
export function deriveVersionDriftVerdict(
  ownVersion: string,
  dist: VersionDistribution,
): VersionDriftVerdict {
  if (dist.size === 0 || dist.majorityVersion === null || dist.newerShare === null) {
    return 'unknown';
  }
  if (dist.newerShare >= FAR_BEHIND_SHARE) return 'far_behind';
  if (compareVersions(ownVersion, dist.majorityVersion) < 0 || dist.newerShare >= BEHIND_SHARE) {
    return 'behind';
  }
  return 'ok';
}
