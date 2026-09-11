import { describe, expect, it } from 'vitest';
import {
  calendarDateKey,
  compareCalendarDates,
  dayEnd,
  dayStart,
  formatCalendarDate,
  parseCalendarDate,
  zoneOffsetMinutes,
} from '../../src/domain/localdate.js';

describe('parseCalendarDate', () => {
  it('parses YYYY-MM-DD', () => {
    expect(parseCalendarDate('2026-09-01')).toEqual({ year: 2026, month: 9, day: 1 });
    expect(parseCalendarDate(' 2024-02-29 ')).toEqual({ year: 2024, month: 2, day: 29 });
  });
  it('rejects malformed strings and non-existent days', () => {
    expect(() => parseCalendarDate('2026/09/01')).toThrow(/YYYY-MM-DD/);
    expect(() => parseCalendarDate('2026-9-1')).toThrow(/YYYY-MM-DD/);
    expect(() => parseCalendarDate('2026-02-30')).toThrow(/valid calendar date/);
    expect(() => parseCalendarDate('2025-02-29')).toThrow(/valid calendar date/);
    expect(() => parseCalendarDate('2026-13-01')).toThrow(/valid calendar date/);
  });
  it('round-trips through formatCalendarDate and compares lexically', () => {
    expect(formatCalendarDate(parseCalendarDate('2026-09-01'))).toBe('2026-09-01');
    expect(
      compareCalendarDates(parseCalendarDate('2026-09-01'), parseCalendarDate('2026-08-31')),
    ).toBeGreaterThan(0);
  });
});

describe('day boundaries', () => {
  it('uses UTC when no zone is configured', () => {
    const d = parseCalendarDate('2026-09-10');
    expect(dayStart(d).toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(dayEnd(d).toISOString()).toBe('2026-09-10T23:59:59.999Z');
  });
  it('applies the zone offset (Asia/Tokyo has no DST)', () => {
    const d = parseCalendarDate('2026-09-10');
    expect(dayStart(d, 'Asia/Tokyo').toISOString()).toBe('2026-09-09T15:00:00.000Z');
    expect(dayEnd(d, 'Asia/Tokyo').toISOString()).toBe('2026-09-10T14:59:59.999Z');
    expect(zoneOffsetMinutes(dayStart(d, 'Asia/Tokyo'), 'Asia/Tokyo')).toBe(540);
  });
  it('handles the DST transition days in America/New_York', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 (EST -> EDT); the day is 23 hours long.
    const spring = parseCalendarDate('2026-03-08');
    expect(dayStart(spring, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(dayEnd(spring, 'America/New_York').toISOString()).toBe('2026-03-09T03:59:59.999Z');
    // 2026-11-01: clocks fall back 02:00 -> 01:00 (EDT -> EST); the day is 25 hours long.
    const fall = parseCalendarDate('2026-11-01');
    expect(dayStart(fall, 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(dayEnd(fall, 'America/New_York').toISOString()).toBe('2026-11-02T04:59:59.999Z');
  });
  it('handles the year boundary', () => {
    const nye = parseCalendarDate('2026-12-31');
    expect(dayEnd(nye, 'Asia/Tokyo').toISOString()).toBe('2026-12-31T14:59:59.999Z');
    expect(dayStart(parseCalendarDate('2027-01-01'), 'Asia/Tokyo').toISOString()).toBe(
      '2026-12-31T15:00:00.000Z',
    );
  });
});

describe('calendarDateKey', () => {
  const instant = new Date('2026-09-10T15:30:00.000Z');
  it('buckets by UTC date by default', () => {
    expect(calendarDateKey(instant)).toBe('2026-09-10');
  });
  it('buckets by local date in the zone', () => {
    expect(calendarDateKey(instant, 'Asia/Tokyo')).toBe('2026-09-11');
    expect(calendarDateKey(instant, 'America/New_York')).toBe('2026-09-10');
    expect(calendarDateKey(new Date('2026-12-31T15:00:00.000Z'), 'Asia/Tokyo')).toBe('2027-01-01');
    expect(calendarDateKey(new Date('2026-12-31T14:59:59.999Z'), 'Asia/Tokyo')).toBe('2026-12-31');
  });
});
