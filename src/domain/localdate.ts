/**
 * Calendar dates (YYYY-MM-DD) in UTC or an IANA time zone, without a date library.
 *
 * Day boundaries in a zone are found by applying the zone offset twice, which handles the days on
 * which the offset changes (DST transitions). Day keys for bucketing come from the same formatter
 * as the local timestamps in output (`formatLocal`), so a receipt is always bucketed into the day
 * its displayed local time falls on.
 */
import { formatLocal } from './time.js';

export interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses "YYYY-MM-DD"; throws for a malformed string or a non-existent day (2026-02-30). */
export function parseCalendarDate(value: string): CalendarDate {
  const match = ISO_DATE.exec(value.trim());
  if (!match) throw new Error(`not a YYYY-MM-DD date: ${JSON.stringify(value)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`not a valid calendar date: ${value.trim()}`);
  }
  return { year, month, day };
}

export function formatCalendarDate(d: CalendarDate): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Offset of `timeZone` from UTC at `date`, in minutes (Asia/Tokyo -> 540). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const local = formatLocal(date, timeZone);
  const match = /([+-])(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error(`could not read the zone offset from ${local}`);
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** First instant of the calendar day (00:00:00.000) in the zone, or in UTC when none is given. */
export function dayStart(d: CalendarDate, timeZone?: string): Date {
  const naiveUtc = Date.UTC(d.year, d.month - 1, d.day, 0, 0, 0, 0);
  if (!timeZone) return new Date(naiveUtc);
  const firstGuess = zoneOffsetMinutes(new Date(naiveUtc), timeZone);
  let candidate = naiveUtc - firstGuess * 60_000;
  const offsetAtCandidate = zoneOffsetMinutes(new Date(candidate), timeZone);
  if (offsetAtCandidate !== firstGuess) candidate = naiveUtc - offsetAtCandidate * 60_000;
  return new Date(candidate);
}

/** Last instant of the calendar day (23:59:59.999) in the zone: the next day's start minus 1 ms. */
export function dayEnd(d: CalendarDate, timeZone?: string): Date {
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  const nextStart = dayStart(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
    timeZone,
  );
  return new Date(nextStart.getTime() - 1);
}

/** The calendar day ("YYYY-MM-DD") an instant falls on in the zone (UTC when none is given). */
export function calendarDateKey(date: Date, timeZone?: string): string {
  return timeZone ? formatLocal(date, timeZone).slice(0, 10) : date.toISOString().slice(0, 10);
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return formatCalendarDate(a).localeCompare(formatCalendarDate(b));
}
