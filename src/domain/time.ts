/**
 * Network timestamp <-> wall clock conversion and formatting.
 *
 * block.timestamp is MILLISECONDS since network epoch; wall clock ms =
 *   epochAdjustment(seconds) * 1000 + timestamp.
 * Mainnet epochAdjustment is 1615853185 (2021-03-16T00:06:25Z) but it is always read from
 * /network/properties, never hard-coded.
 */

export interface Instant {
  /** ISO 8601 in UTC, e.g. 2026-01-15T03:12:45.000Z */
  readonly utc: string;
  /** Same instant in SYMBOL_TIMEZONE as ISO-like local time with offset, when configured. */
  readonly local?: string;
}

/** The last millisecond a Date can hold, on either side of 1970 (ECMAScript, not a network value). */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * A network timestamp that gives no valid time. A node may send any uint64, up to 2^64 - 1 ms, far
 * beyond the last date JavaScript knows (a value too long for a number, which the REST schema
 * refuses, is caught here too). A caller that can answer without the time catches this error
 * (symbol_node_status makes the check concerned unknown), and symbol_transaction_status catches it
 * to name the transactions concerned; for any other caller describeError says that the node
 * returned a time that cannot be shown as a date.
 */
export class InvalidNetworkTimestampError extends Error {
  constructor(timestampMs: string | number | bigint) {
    super(`invalid network timestamp: ${timestampMs}`);
    this.name = 'InvalidNetworkTimestampError';
  }
}

/**
 * A Date that holds no time, met where a date is written as text. It comes from arithmetic that
 * left the range of Date: a height or an epoch too far from the current one (estimateDateAtHeight),
 * or an epoch adjustment that is no time. The value that caused it is not known here.
 */
export class InvalidDateError extends Error {
  constructor() {
    super('the date holds no valid time (outside the range of Date)');
    this.name = 'InvalidDateError';
  }
}

export function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

/** The two errors of a time that cannot be shown as a date; describeError words them alike. */
export function isUnusableTimeError(
  err: unknown,
): err is InvalidNetworkTimestampError | InvalidDateError {
  return err instanceof InvalidNetworkTimestampError || err instanceof InvalidDateError;
}

/** The last network timestamp (ms) that networkTimestampToDate accepts for this epoch adjustment. */
export function lastNetworkTimestamp(epochAdjustmentSeconds: number): number {
  return MAX_DATE_MS - epochAdjustmentSeconds * 1000;
}

/**
 * Wall-clock time of a network timestamp. Throws InvalidNetworkTimestampError for a timestamp that
 * is not a finite, non-negative number or that lies beyond the range of Date, so that no such value
 * ever becomes a Date (formatting one would throw later, far from the value that caused it).
 */
export function networkTimestampToDate(
  timestampMs: string | number | bigint,
  epochAdjustmentSeconds: number,
): Date {
  const ts = Number(timestampMs);
  const date = new Date(epochAdjustmentSeconds * 1000 + ts);
  if (!Number.isFinite(ts) || ts < 0 || Number.isNaN(date.getTime())) {
    throw new InvalidNetworkTimestampError(timestampMs);
  }
  return date;
}

export function dateToNetworkTimestamp(date: Date, epochAdjustmentSeconds: number): number {
  return date.getTime() - epochAdjustmentSeconds * 1000;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats a date in an IANA zone as YYYY-MM-DDTHH:mm:ss+HH:MM. Throws InvalidDateError for a Date
 * that holds no time.
 */
export function formatLocal(date: Date, timeZone: string): string {
  if (!isValidDate(date)) throw new InvalidDateError();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  });
  const parts = new Map(fmt.formatToParts(date).map((p) => [p.type, p.value] as const));
  const offsetRaw = parts.get('timeZoneName') ?? 'GMT';
  // "GMT+09:00" -> "+09:00", "GMT" -> "+00:00"
  const offset = offsetRaw === 'GMT' ? '+00:00' : offsetRaw.replace(/^GMT/, '');
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}${offset}`;
}

/**
 * The instant as output shows it. Throws InvalidDateError for a Date that holds no time, where
 * toISOString would throw a RangeError that says nothing about its cause.
 */
export function formatInstant(date: Date, timeZone?: string): Instant {
  if (!isValidDate(date)) throw new InvalidDateError();
  const utc = date.toISOString();
  return timeZone ? { utc, local: formatLocal(date, timeZone) } : { utc };
}

/**
 * Renders an instant for prose (summaries, warnings): the local time first when a zone is
 * configured, always followed by the UTC form, e.g. "2026-01-15T12:00:00+09:00 (2026-01-15T03:00:00.000Z)".
 */
export function formatInstantText(instant: Instant): string {
  return instant.local ? `${instant.local} (${instant.utc})` : instant.utc;
}

/**
 * Estimates the wall-clock time at which `targetHeight` will be reached, using the measured
 * average block time. Negative distances (past heights) are extrapolated backwards. A height too
 * far from the current one gives a Date that holds no time; formatInstant refuses it.
 */
export function estimateDateAtHeight(
  currentHeight: number,
  targetHeight: number,
  averageBlockTimeMs: number,
  now: Date,
): Date {
  if (!Number.isFinite(averageBlockTimeMs) || averageBlockTimeMs <= 0) {
    throw new Error('averageBlockTimeMs must be positive');
  }
  return new Date(now.getTime() + (targetHeight - currentHeight) * averageBlockTimeMs);
}

export function msToDays(ms: number): number {
  return ms / 86_400_000;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
