import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../../src/domain/csv.js';

describe('toCsv', () => {
  it('writes a header, one line per row, LF endings and a trailing LF', () => {
    const csv = toCsv(
      ['period', 'receipts', 'xym'],
      [
        ['2026-08', 674, '23237.845492'],
        ['2026-09', 20, '662.574177'],
      ],
    );
    expect(csv).toBe('period,receipts,xym\n2026-08,674,23237.845492\n2026-09,20,662.574177\n');
    expect(csv).not.toContain('\r');
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.split('\n')).toHaveLength(4); // header + 2 rows + the empty string after the last LF
  });

  it('keeps numbers without thousands separators', () => {
    expect(toCsv(['n'], [[1234567]])).toBe('n\n1234567\n');
  });

  it('writes only the header for no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\n');
  });

  it('quotes cells that contain a comma, a quote, CR or LF (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rlf')).toBe('"cr\rlf"');
    expect(csvCell(42)).toBe('42');
    expect(toCsv(['x'], [['a,b']])).toBe('x\n"a,b"\n');
  });

  it('refuses rows whose width differs from the header', () => {
    expect(() => toCsv(['a', 'b'], [[1]])).toThrow(/row 0 has 1 cells, header has 2/);
  });
});
