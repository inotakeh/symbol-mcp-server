import { describe, expect, it } from 'vitest';
import {
  BEHIND_SHARE,
  compareVersions,
  deriveVersionDriftVerdict,
  FAR_BEHIND_SHARE,
  parseVersion,
  versionDistribution,
} from '../../src/domain/version.js';

describe('parseVersion / compareVersions', () => {
  it('compares component-wise, not as strings', () => {
    expect(parseVersion('1.0.3.10')).toEqual([1, 0, 3, 10]);
    expect(compareVersions('1.0.3.10', '1.0.3.9')).toBe(1);
    expect('1.0.3.10' < '1.0.3.9').toBe(true); // the string order this replaces
    expect(compareVersions('1.0.3.9', '1.0.3.10')).toBe(-1);
    expect(compareVersions('1.0.3.9', '1.0.3.9')).toBe(0);
    expect(compareVersions('2.4.4', '2.10.0')).toBe(-1);
  });
  it('treats missing components as zero', () => {
    expect(compareVersions('1.0.3', '1.0.3.0')).toBe(0);
    expect(compareVersions('1.0.3.1', '1.0.3')).toBe(1);
  });
  it('rejects malformed versions', () => {
    expect(() => parseVersion('1.0.x')).toThrow();
    expect(() => parseVersion('')).toThrow();
    expect(() => compareVersions('1.0', 'v1.0')).toThrow();
  });
});

describe('versionDistribution', () => {
  it('counts versions, sorts by count then version, and measures the newer share', () => {
    const dist = versionDistribution(['1.0.3.9', '1.0.4.0', '1.0.3.9', '1.0.3.8'], '1.0.3.9');
    expect(dist.size).toBe(4);
    expect(dist.distribution).toEqual([
      { version: '1.0.3.9', count: 2, share: 0.5 },
      { version: '1.0.4.0', count: 1, share: 0.25 },
      { version: '1.0.3.8', count: 1, share: 0.25 },
    ]);
    expect(dist.majorityVersion).toBe('1.0.3.9');
    expect(dist.newerShare).toBe(0.25);
  });
  it('breaks a tie towards the newer version', () => {
    const dist = versionDistribution(['1.0.3.9', '1.0.4.0'], '1.0.3.9');
    expect(dist.majorityVersion).toBe('1.0.4.0');
    expect(dist.distribution.map((b) => b.version)).toEqual(['1.0.4.0', '1.0.3.9']);
  });
  it('handles an empty sample', () => {
    expect(versionDistribution([], '1.0.3.9')).toEqual({
      size: 0,
      distribution: [],
      majorityVersion: null,
      newerShare: null,
    });
  });
});

describe('deriveVersionDriftVerdict', () => {
  const own = '1.0.3.9';
  const dist = (sample: string[]) => versionDistribution(sample, own);
  it('is ok when the node runs the majority version or a newer one', () => {
    expect(deriveVersionDriftVerdict(own, dist(['1.0.3.9', '1.0.3.9', '1.0.3.8']))).toBe('ok');
    expect(deriveVersionDriftVerdict(own, dist(['1.0.3.8', '1.0.3.8']))).toBe('ok');
  });
  it('is behind when older than the majority', () => {
    expect(deriveVersionDriftVerdict(own, dist(['1.0.4.0', '1.0.4.0', '1.0.3.9', '1.0.3.8']))).toBe(
      'behind',
    );
  });
  it('is behind when newer versions together reach half the sample even if own is the mode', () => {
    // own 40%, two newer versions 30% each: newerShare 0.6.
    const sample = [
      '1.0.3.9',
      '1.0.3.9',
      '1.0.3.9',
      '1.0.3.9',
      '1.0.4.0',
      '1.0.4.0',
      '1.0.4.0',
      '1.0.4.1',
      '1.0.4.1',
      '1.0.4.1',
    ];
    const d = dist(sample);
    expect(d.majorityVersion).toBe(own);
    expect(d.newerShare).toBe(0.6);
    expect(deriveVersionDriftVerdict(own, d)).toBe('behind');
    expect(BEHIND_SHARE).toBe(0.5);
  });
  it('is far_behind from a 75% newer share, and behind just below it', () => {
    expect(FAR_BEHIND_SHARE).toBe(0.75);
    expect(deriveVersionDriftVerdict(own, dist(['1.0.4.0', '1.0.4.0', '1.0.4.0', '1.0.3.9']))).toBe(
      'far_behind',
    );
    const sample = [
      ...Array.from({ length: 7499 }, () => '1.0.4.0'),
      ...Array.from({ length: 2501 }, () => own),
    ];
    expect(dist(sample).newerShare).toBe(0.7499);
    expect(deriveVersionDriftVerdict(own, dist(sample))).toBe('behind');
  });
  it('is unknown for an empty sample', () => {
    expect(deriveVersionDriftVerdict(own, dist([]))).toBe('unknown');
  });
});
