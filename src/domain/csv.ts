/**
 * Minimal RFC 4180 CSV writer for spreadsheet output: a header row plus one row per record,
 * comma-separated, LF line endings (one after every row, the last included), UTF-8 without a
 * byte-order mark, and no totals row (spreadsheets sum for themselves). Cells are numbers or
 * strings; a string containing a comma, a double quote, CR or LF is enclosed in double quotes
 * with inner quotes doubled. Callers only pass numbers, decimal strings and ISO timestamps, so
 * quoting never triggers in practice; it is applied anyway.
 */
export type CsvCell = string | number;

export function csvCell(value: CsvCell): string {
  const text = typeof value === 'number' ? String(value) : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  for (const [i, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new Error(`csv row ${i} has ${row.length} cells, header has ${header.length}`);
    }
  }
  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}
