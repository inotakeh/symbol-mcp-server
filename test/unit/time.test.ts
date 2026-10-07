import { describe, expect, it } from 'vitest';
import {
  dateToNetworkTimestamp,
  estimateDateAtHeight,
  formatInstant,
  formatInstantText,
  formatLocal,
  InvalidNetworkTimestampError,
  isValidTimeZone,
  networkTimestampToDate,
} from '../../src/domain/time.js';

const EPOCH_ADJUSTMENT = 1_615_853_185; // mainnet, read from /network/properties in production

describe('network timestamps', () => {
  it('converts the fixture block timestamp to wall clock', () => {
    const date = networkTimestampToDate('173156113808', EPOCH_ADJUSTMENT);
    expect(date.toISOString()).toBe('2026-09-10T03:01:38.808Z');
  });
  it('maps timestamp 0 to the epoch adjustment', () => {
    expect(networkTimestampToDate(0, EPOCH_ADJUSTMENT).toISOString()).toBe(
      '2021-03-16T00:06:25.000Z',
    );
  });
  it('round-trips', () => {
    const d = new Date('2026-09-10T03:01:38.808Z');
    expect(dateToNetworkTimestamp(d, EPOCH_ADJUSTMENT)).toBe(173_156_113_808);
  });
  it('rejects negative or non-numeric timestamps', () => {
    expect(() => networkTimestampToDate('x', EPOCH_ADJUSTMENT)).toThrow(
      InvalidNetworkTimestampError,
    );
    expect(() => networkTimestampToDate(-1, EPOCH_ADJUSTMENT)).toThrow(
      InvalidNetworkTimestampError,
    );
  });
  it('rejects a timestamp that gives no valid time instead of returning an invalid date', () => {
    // Every digit string passes the uint64 schema of the REST client: beyond the last date
    // JavaScript knows (twice), and too long to be a finite number.
    for (const timestamp of ['9000000000000000', '99999999999999999999', '9'.repeat(400)]) {
      expect(() => networkTimestampToDate(timestamp, EPOCH_ADJUSTMENT)).toThrow(
        InvalidNetworkTimestampError,
      );
    }
    expect(() => networkTimestampToDate(10n ** 20n, EPOCH_ADJUSTMENT)).toThrow(
      'invalid network timestamp: 100000000000000000000',
    );
  });
  it('accepts the last timestamp that still gives a date, and not the next one', () => {
    // The last instant of a Date is 8.64e15 ms after 1970.
    const last = 8_640_000_000_000_000 - EPOCH_ADJUSTMENT * 1000;
    expect(networkTimestampToDate(last, EPOCH_ADJUSTMENT).toISOString()).toBe(
      '+275760-09-13T00:00:00.000Z',
    );
    expect(() => networkTimestampToDate(last + 1, EPOCH_ADJUSTMENT)).toThrow(
      InvalidNetworkTimestampError,
    );
  });
});

describe('formatting', () => {
  const d = new Date('2026-09-10T03:01:38.808Z');
  it('formats local time with offset', () => {
    expect(formatLocal(d, 'Asia/Tokyo')).toBe('2026-09-10T12:01:38+09:00');
    expect(formatLocal(d, 'UTC')).toBe('2026-09-10T03:01:38+00:00');
    expect(formatLocal(d, 'America/New_York')).toBe('2026-09-09T23:01:38-04:00');
  });
  it('omits local when no zone is configured', () => {
    expect(formatInstant(d)).toEqual({ utc: '2026-09-10T03:01:38.808Z' });
    expect(formatInstant(d, 'Asia/Tokyo')).toEqual({
      utc: '2026-09-10T03:01:38.808Z',
      local: '2026-09-10T12:01:38+09:00',
    });
  });
  it('renders prose with local first and UTC always present', () => {
    expect(formatInstantText(formatInstant(d, 'Asia/Tokyo'))).toBe(
      '2026-09-10T12:01:38+09:00 (2026-09-10T03:01:38.808Z)',
    );
    expect(formatInstantText(formatInstant(d))).toBe('2026-09-10T03:01:38.808Z');
  });
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('estimateDateAtHeight', () => {
  const now = new Date('2026-09-10T03:00:00.000Z');
  it('extrapolates forward with the measured block time', () => {
    const est = estimateDateAtHeight(100, 200, 30_030, now);
    expect(est.getTime() - now.getTime()).toBe(100 * 30_030);
  });
  it('extrapolates backwards for past heights', () => {
    const est = estimateDateAtHeight(200, 100, 30_000, now);
    expect(est.getTime()).toBe(now.getTime() - 100 * 30_000);
  });
  it('rejects a non-positive block time', () => {
    expect(() => estimateDateAtHeight(1, 2, 0, now)).toThrow();
  });
});
