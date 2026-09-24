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

/**
 * A packed version of 0 (0.0.0.0) is not a release: it means the node does not know that peer's
 * version yet. catapult creates the peers it reads from its peers files with
 * NodeMetadata(networkFingerprint, name), whose Version is NodeVersion(), i.e. 0
 * (client/catapult/src/catapult/config/PeersConfiguration.cpp, ionet/Node.h), and /node/peers
 * returns them as version 0 until the node learns the real one.
 */
export function isUnreportedVersion(version: number): boolean {
  return version === 0;
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
  /**
   * Share of the sample running a version newer than `ownVersion`; null when the sample is empty
   * or the node's own version is not known.
   */
  readonly newerShare: number | null;
}

/**
 * Frequency distribution of the sampled versions. Ties are broken towards the newer version: a
 * tie means the network is mid-migration and the newer version is the one it converges on, so
 * the operator gets a warning they can dismiss rather than silence. `ownVersion` is null when the
 * node reported version 0 for itself (isUnreportedVersion): the distribution and the majority
 * still stand, but nothing can be newer than an unknown version.
 */
export function versionDistribution(
  sample: readonly string[],
  ownVersion: string | null,
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
  let newerShare: number | null = null;
  if (size > 0 && ownVersion !== null) {
    const newer = sample.filter((v) => compareVersions(v, ownVersion) > 0).length;
    newerShare = roundTo(newer / size, 4);
  }
  return {
    size,
    distribution,
    majorityVersion: distribution[0]?.version ?? null,
    newerShare,
  };
}

/** Share of newer versions from which the node is considered far behind (policy, not a network constant). */
export const FAR_BEHIND_SHARE = 0.75;
/** Share of newer versions from which the node is considered behind even when its version is the mode. */
export const BEHIND_SHARE = 0.5;

export type VersionDriftVerdict = 'ok' | 'behind' | 'far_behind' | 'unknown';

/**
 * Own version not known (null) or empty sample -> unknown. newerShare >= 0.75 -> far_behind.
 * Older than the majority, or newerShare >= 0.5 (own version is still the mode but newer versions
 * together dominate) -> behind. Otherwise ok, including when the node is newer than the majority.
 */
export function deriveVersionDriftVerdict(
  ownVersion: string | null,
  dist: VersionDistribution,
): VersionDriftVerdict {
  if (
    ownVersion === null ||
    dist.size === 0 ||
    dist.majorityVersion === null ||
    dist.newerShare === null
  ) {
    return 'unknown';
  }
  if (dist.newerShare >= FAR_BEHIND_SHARE) return 'far_behind';
  if (compareVersions(ownVersion, dist.majorityVersion) < 0 || dist.newerShare >= BEHIND_SHARE) {
    return 'behind';
  }
  return 'ok';
}
