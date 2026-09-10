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

export function networkTimestampToDate(
  timestampMs: string | number | bigint,
  epochAdjustmentSeconds: number,
): Date {
  const ts = typeof timestampMs === 'bigint' ? Number(timestampMs) : Number(timestampMs);
  if (!Number.isFinite(ts) || ts < 0) throw new Error(`invalid network timestamp: ${timestampMs}`);
  return new Date(epochAdjustmentSeconds * 1000 + ts);
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

/** Formats a date in an IANA zone as YYYY-MM-DDTHH:mm:ss+HH:MM. */
export function formatLocal(date: Date, timeZone: string): string {
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

export function formatInstant(date: Date, timeZone?: string): Instant {
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
 * average block time. Negative distances (past heights) are extrapolated backwards.
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
