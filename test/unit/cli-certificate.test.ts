/**
 * The pure half of the `certificate` item of `symbol-mcp-server check` (src/cli/certificate.ts):
 * the X.509 time parser, the expiry thresholds, the comparison of copies and the wording, and what
 * a file that is not a certificate (a private key above all) leaves in the output.
 * test/tools/cli_check.test.ts runs the item inside the whole check.
 */
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CERT_FAIL_DAYS,
  type CertificateFile,
  CertificateFileSchema,
  certificateDaysLeft,
  certificateFileLine,
  checkCertificates,
  commonNameOf,
  DEFAULT_CERT_WARN_DAYS,
  describeCertificateFile,
  differingCopies,
  judgeCertificateExpiry,
  loadCertificate,
  MAX_CERT_FILE_BYTES,
  NO_EXPIRY_REASON,
  NOT_A_CERTIFICATE_REASON,
  NOT_A_FILE_REASON,
  PRIVATE_KEY_REASON,
  parseCertificate,
  parseX509Time,
  summarizeCertificates,
  TOO_LARGE_REASON,
} from '../../src/cli/certificate.js';

const DAY_MS = 86_400_000;
const at = (codePoint: number) => String.fromCodePoint(codePoint);
const FP_A = Array.from({ length: 32 }, () => 'AA').join(':');
const FP_B = Array.from({ length: 32 }, () => 'BB').join(':');

/** A file entry as describeCertificateFile builds it for a certificate that was read. */
function read(
  path: string,
  daysLeft: number,
  over: Partial<CertificateFile> = {},
): CertificateFile {
  return {
    path,
    status: judgeCertificateExpiry(daysLeft, DEFAULT_CERT_WARN_DAYS),
    notAfter: '2027-10-05T02:11:09.000Z',
    daysLeft,
    fingerprint256: FP_A,
    commonName: 'test-node-a',
    reason: null,
    ...over,
  };
}

function unusable(path: string, reason: string): CertificateFile {
  return {
    path,
    status: 'fail',
    notAfter: null,
    daysLeft: null,
    fingerprint256: null,
    commonName: null,
    reason,
  };
}

describe('parseX509Time', () => {
  it('reads the text node:crypto gives for validTo, with a one- or two-digit day', () => {
    expect(parseX509Time('Oct  5 02:11:09 2027 GMT')?.toISOString()).toBe(
      '2027-10-05T02:11:09.000Z',
    );
    expect(parseX509Time('Dec 31 23:59:59 2099 GMT')?.toISOString()).toBe(
      '2099-12-31T23:59:59.000Z',
    );
    expect(parseX509Time('Jan 1 00:00:00 2030 GMT')?.toISOString()).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    expect(parseX509Time('Feb 29 12:00:00 2028 GMT')?.toISOString()).toBe(
      '2028-02-29T12:00:00.000Z',
    );
  });

  it('drops a fraction of a second, which OpenSSL prints when the certificate has one', () => {
    expect(parseX509Time('Dec 31 23:59:59.123 2099 GMT')?.toISOString()).toBe(
      '2099-12-31T23:59:59.000Z',
    );
    expect(parseX509Time('Oct  5 02:11:09.5 2027 GMT')?.toISOString()).toBe(
      '2027-10-05T02:11:09.000Z',
    );
  });

  it('refuses every other form, and a date or time that does not exist', () => {
    for (const bad of [
      '',
      '2027-10-05T02:11:09.000Z',
      'Oct  5 02:11:09 2027',
      'Oct  5 02:11:09 2027 UTC',
      ' Oct  5 02:11:09 2027 GMT',
      'Oct  5 02:11:09 2027 GMT ',
      'Okt  5 02:11:09 2027 GMT',
      'oct  5 02:11:09 2027 GMT',
      'Oct   5 02:11:09 2027 GMT',
      'Oct  5 2:11:09 2027 GMT',
      'Oct  5 02:11:09. 2027 GMT',
      'Oct  5 02:11:09,500 2027 GMT',
      // What node:crypto gives for a notAfter that is not a real time.
      'Bad time value',
      'Feb 30 00:00:00 2027 GMT',
      'Feb 29 00:00:00 2027 GMT',
      'Oct  0 02:11:09 2027 GMT',
      'Oct  5 24:00:00 2027 GMT',
      'Oct  5 02:60:00 2027 GMT',
      'Oct  5 02:11:60 2027 GMT',
    ]) {
      expect(parseX509Time(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('commonNameOf', () => {
  it('takes the CN of the subject, and the first one when there are several', () => {
    expect(commonNameOf({ CN: 'test-node-a' })).toBe('test-node-a');
    expect(commonNameOf({ C: 'JP', O: 'Example', CN: 'node cert' } as { CN: string })).toBe(
      'node cert',
    );
    expect(commonNameOf({ CN: ['first', 'second'] })).toBe('first');
  });

  it('is null without a CN', () => {
    expect(commonNameOf({})).toBeNull();
    expect(commonNameOf(null)).toBeNull();
    expect(commonNameOf(undefined)).toBeNull();
    expect(commonNameOf({ CN: '' })).toBeNull();
    expect(commonNameOf({ CN: [] })).toBeNull();
    expect(commonNameOf({ CN: 7 })).toBeNull();
  });

  it('makes the name one clean line, cut at 64 characters', () => {
    const hidden = `node${at(0x1b)}[2J${at(0x202e)} a${at(0x09)}b${at(0xe0041)}${at(0x0a)}CN=c`;
    expect(commonNameOf({ CN: hidden })).toBe('node[2J a b CN=c');
    expect(commonNameOf({ CN: `${at(0x200b)}${at(0x200b)}` })).toBeNull();
    expect(commonNameOf({ CN: 'n'.repeat(100) })).toBe(`${'n'.repeat(64)}\u2026`);
  });
});

describe('certificateDaysLeft and judgeCertificateExpiry', () => {
  const notAfter = new Date('2027-10-05T02:11:09.000Z');
  const msBefore = (ms: number) => new Date(notAfter.getTime() - ms);
  const judge = (now: Date, warnDays = DEFAULT_CERT_WARN_DAYS) => {
    const daysLeft = certificateDaysLeft(notAfter, now);
    return [daysLeft, judgeCertificateExpiry(daysLeft, warnDays)] as const;
  };

  it('counts whole days rounded down: 0 on the last day, negative once expired', () => {
    expect(certificateDaysLeft(notAfter, msBefore(366 * DAY_MS))).toBe(366);
    expect(certificateDaysLeft(notAfter, msBefore(366 * DAY_MS - 1))).toBe(365);
    expect(certificateDaysLeft(notAfter, msBefore(DAY_MS))).toBe(1);
    expect(certificateDaysLeft(notAfter, msBefore(DAY_MS - 1))).toBe(0);
    expect(certificateDaysLeft(notAfter, msBefore(1))).toBe(0);
    expect(certificateDaysLeft(notAfter, notAfter)).toBe(0);
    expect(certificateDaysLeft(notAfter, msBefore(-1))).toBe(-1);
    expect(certificateDaysLeft(notAfter, msBefore(-DAY_MS))).toBe(-1);
    expect(certificateDaysLeft(notAfter, msBefore(-DAY_MS - 1))).toBe(-2);
  });

  it('is ok with 30 days or more left and warns below that (the default --cert-warn-days)', () => {
    expect(judge(msBefore(400 * DAY_MS))).toEqual([400, 'ok']);
    expect(judge(msBefore(30 * DAY_MS))).toEqual([30, 'ok']);
    expect(judge(msBefore(30 * DAY_MS - 1))).toEqual([29, 'warn']);
    expect(judge(msBefore(7 * DAY_MS))).toEqual([7, 'warn']);
  });

  it('fails with fewer than 7 days left, on the last day and once expired', () => {
    expect(CERT_FAIL_DAYS).toBe(7);
    expect(judge(msBefore(7 * DAY_MS - 1))).toEqual([6, 'fail']);
    expect(judge(msBefore(1))).toEqual([0, 'fail']);
    expect(judge(notAfter)).toEqual([0, 'fail']);
    expect(judge(msBefore(-1))).toEqual([-1, 'fail']);
    expect(judge(msBefore(-400 * DAY_MS))).toEqual([-400, 'fail']);
  });

  it('moves only the warn threshold with --cert-warn-days; the 7 days of fail stay', () => {
    expect(judge(msBefore(60 * DAY_MS), 60)).toEqual([60, 'ok']);
    expect(judge(msBefore(60 * DAY_MS - 1), 60)).toEqual([59, 'warn']);
    // At or below 7 there is no warn band: ok down to 7 days, then fail.
    for (const warnDays of [1, 7]) {
      expect(judge(msBefore(7 * DAY_MS), warnDays)).toEqual([7, 'ok']);
      expect(judge(msBefore(7 * DAY_MS - 1), warnDays)).toEqual([6, 'fail']);
    }
  });
});

describe('describeCertificateFile', () => {
  const now = new Date('2026-10-04T02:11:09.000Z');
  const loaded = {
    ok: true,
    notAfter: new Date('2027-10-05T02:11:09.000Z'),
    fingerprint256: FP_A,
    commonName: 'test-node-a',
  } as const;

  it('reports the path as given with the expiry, the days left, the fingerprint and the CN', () => {
    const file = describeCertificateFile('cert/node.crt.pem', loaded, now, 30);
    expect(file).toEqual({
      path: 'cert/node.crt.pem',
      status: 'ok',
      notAfter: '2027-10-05T02:11:09.000Z',
      daysLeft: 366,
      fingerprint256: FP_A,
      commonName: 'test-node-a',
      reason: null,
    });
    expect(CertificateFileSchema.parse(file)).toEqual(file);
    expect(describeCertificateFile('a', loaded, now, 400).status).toBe('warn');
  });

  it('fails a file that could not be used, with the reason and nothing else', () => {
    const file = describeCertificateFile('a', { ok: false, reason: PRIVATE_KEY_REASON }, now, 30);
    expect(file).toEqual(unusable('a', PRIVATE_KEY_REASON));
    expect(CertificateFileSchema.parse(file)).toEqual(file);
  });

  it('prints the path as one clean line', () => {
    const path = `dir${at(0x0a)}name${at(0x1b)}[31m${at(0x202e)}.crt`;
    expect(describeCertificateFile(path, loaded, now, 30).path).toBe('dir name[31m.crt');
    expect(describeCertificateFile(at(0x07), loaded, now, 30).path).toBe('(unprintable path)');
  });
});

describe('differingCopies', () => {
  it('is null when every file that was read is the same certificate', () => {
    expect(differingCopies([read('a', 366)])).toBeNull();
    expect(differingCopies([read('a', 366), read('b', 366)])).toBeNull();
    expect(differingCopies([])).toBeNull();
  });

  it('names the first file of each distinct certificate, in the order given', () => {
    const b = { fingerprint256: FP_B };
    expect(differingCopies([read('a', 366), read('b', 366, b)])).toEqual(['a', 'b']);
    expect(differingCopies([read('a', 366), read('a2', 366), read('c', 366, b)])).toEqual([
      'a',
      'c',
    ]);
    expect(differingCopies([read('b', 366, b), read('a', 366), read('b2', 366, b)])).toEqual([
      'b',
      'a',
    ]);
  });

  it('leaves out a file that could not be read: one certificate is not compared with nothing', () => {
    expect(differingCopies([read('a', 366), unusable('b', 'cannot be read (ENOENT)')])).toBeNull();
  });
});

describe('summarizeCertificates', () => {
  const b = { fingerprint256: FP_B, commonName: 'test-node-b' };

  it('answers with the count and the expiry when the files are copies of one certificate', () => {
    expect(summarizeCertificates([read('a', 366), read('b', 366)])).toEqual({
      status: 'ok',
      detail: 'ok (2 files, expires 2027-10-05, 366 days left)',
    });
    expect(summarizeCertificates([read('a', 30)])).toEqual({
      status: 'ok',
      detail: 'ok (1 file, expires 2027-10-05, 30 days left)',
    });
    expect(summarizeCertificates([read('a', 16), read('b', 16)])).toEqual({
      status: 'warn',
      detail: 'warn (2 files, expires 2027-10-05, 16 days left)',
    });
    expect(summarizeCertificates([read('a', 1)])).toEqual({
      status: 'fail',
      detail: 'fail (1 file, expires 2027-10-05, 1 day left)',
    });
    expect(summarizeCertificates([read('a', 0)]).detail).toBe(
      'fail (1 file, expires 2027-10-05, 0 days left)',
    );
    expect(summarizeCertificates([read('a', -4), read('b', -4)])).toEqual({
      status: 'fail',
      detail: 'fail (2 files, expired 2027-10-05)',
    });
  });

  it('warns when the files are not the same certificate, and says which differ', () => {
    expect(summarizeCertificates([read('node/a.crt', 366), read('rest/b.crt', 300, b)])).toEqual({
      status: 'warn',
      detail: 'warn (copies differ: node/a.crt vs rest/b.crt)',
    });
    // Three files, two certificates: one path per certificate.
    expect(summarizeCertificates([read('a', 366), read('a2', 366), read('c', 300, b)]).detail).toBe(
      'warn (copies differ: a vs c)',
    );
  });

  it('names each file that is not ok before the copies that differ', () => {
    const old = { ...b, notAfter: '2026-10-20T02:11:09.000Z' };
    expect(summarizeCertificates([read('a', 366), read('b', 16, old)])).toEqual({
      status: 'warn',
      detail: 'warn (b: expires 2026-10-20, 16 days left; copies differ: a vs b)',
    });
    expect(summarizeCertificates([read('a', 366), read('b', 4, old)])).toEqual({
      status: 'fail',
      detail: 'fail (b: expires 2026-10-20, 4 days left; copies differ: a vs b)',
    });
    expect(summarizeCertificates([read('a', 366), read('b', -1, old)]).detail).toBe(
      'fail (b: expired 2026-10-20; copies differ: a vs b)',
    );
  });

  it('fails with the reason of a file that could not be used, and still judges the others', () => {
    expect(summarizeCertificates([unusable('key', PRIVATE_KEY_REASON), read('a', 366)])).toEqual({
      status: 'fail',
      detail: `fail (key: ${PRIVATE_KEY_REASON})`,
    });
    expect(
      summarizeCertificates([
        read('a', 366),
        unusable('gone', 'cannot be read (ENOENT)'),
        read('c', 20, b),
      ]),
    ).toEqual({
      status: 'fail',
      detail:
        'fail (gone: cannot be read (ENOENT); c: expires 2027-10-05, 20 days left; copies differ: a vs c)',
    });
    expect(summarizeCertificates([unusable('x', NOT_A_CERTIFICATE_REASON)]).detail).toBe(
      `fail (x: ${NOT_A_CERTIFICATE_REASON})`,
    );
  });
});

describe('certificateFileLine', () => {
  it('gives the path, the verdict, notAfter, the days left and the fingerprint', () => {
    expect(certificateFileLine(read('cert/node.crt.pem', 366))).toBe(
      `cert/node.crt.pem: ok, expires 2027-10-05T02:11:09.000Z, 366 days left, sha256 ${FP_A}`,
    );
    expect(certificateFileLine(read('a', 1))).toBe(
      `a: fail, expires 2027-10-05T02:11:09.000Z, 1 day left, sha256 ${FP_A}`,
    );
    expect(certificateFileLine(read('a', -4))).toBe(
      `a: fail, expired 2027-10-05T02:11:09.000Z, sha256 ${FP_A}`,
    );
  });

  it('gives the reason for a file that could not be used', () => {
    expect(certificateFileLine(unusable('node.key', PRIVATE_KEY_REASON))).toBe(
      `node.key: fail, ${PRIVATE_KEY_REASON}`,
    );
  });
});

describe('files that are not certificates', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbol-mcp-cert-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A real private key made for this test run only; it is never written to the repository. */
  function privateKeyPem(): string {
    const { privateKey } = generateKeyPairSync('ed25519');
    return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
  const now = new Date('2026-10-04T00:00:00.000Z');

  it('refuses a private key without parsing it, whatever its label', () => {
    const pem = privateKeyPem();
    expect(pem).toContain('PRIVATE KEY');
    expect(parseCertificate(Buffer.from(pem))).toEqual({ ok: false, reason: PRIVATE_KEY_REASON });
    for (const label of ['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      const other = `-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----\n`;
      expect(parseCertificate(Buffer.from(other))).toEqual({
        ok: false,
        reason: PRIVATE_KEY_REASON,
      });
    }
    // A key after a certificate block in one file: the whole file is refused.
    const mixed = `-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n${pem}`;
    expect(parseCertificate(Buffer.from(mixed))).toEqual({ ok: false, reason: PRIVATE_KEY_REASON });
  });

  it('reports what is not a certificate without quoting it', () => {
    const publicKey = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    for (const content of [
      '',
      'just some notes, not a certificate\n',
      publicKey,
      '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n',
      '-----BEGIN CERTIFICATE-----\n',
    ]) {
      expect(parseCertificate(Buffer.from(content))).toEqual({
        ok: false,
        reason: NOT_A_CERTIFICATE_REASON,
      });
    }
    expect(parseCertificate(Buffer.from([0x30, 0x82, 0x01, 0x00, 0xff]))).toEqual({
      ok: false,
      reason: NOT_A_CERTIFICATE_REASON,
    });
  });

  it('fails a path that cannot be read, a directory and an oversized file, each with its reason', async () => {
    expect(await loadCertificate(join(dir, 'missing.crt'))).toEqual({
      ok: false,
      reason: 'cannot be read (ENOENT)',
    });
    expect(await loadCertificate(dir)).toEqual({ ok: false, reason: NOT_A_FILE_REASON });
    const big = join(dir, 'big.crt');
    writeFileSync(big, Buffer.alloc(MAX_CERT_FILE_BYTES + 1, 0x41));
    expect(await loadCertificate(big)).toEqual({ ok: false, reason: TOO_LARGE_REASON });
    const full = join(dir, 'full.crt');
    writeFileSync(full, Buffer.alloc(MAX_CERT_FILE_BYTES, 0x41));
    expect(await loadCertificate(full)).toEqual({ ok: false, reason: NOT_A_CERTIFICATE_REASON });
  });

  it('resolves a relative path against the current directory', async () => {
    const notes = join(dir, 'notes.txt');
    writeFileSync(notes, 'hello\n');
    expect(await loadCertificate(relative(process.cwd(), notes))).toEqual({
      ok: false,
      reason: NOT_A_CERTIFICATE_REASON,
    });
  });

  it('checkCertificates fails each such file, keeps going, and prints nothing of their content', async () => {
    const pem = privateKeyPem();
    const key = join(dir, 'passed-by-mistake.txt');
    writeFileSync(key, pem);
    const notes = join(dir, 'notes.txt');
    writeFileSync(notes, 'SECRET-NOTE-0123456789 is not a certificate\n');
    const missing = join(dir, 'missing.crt');

    const result = await checkCertificates([key, notes, missing], 30, now);
    expect(result.status).toBe('fail');
    expect(result.hint).toBeNull();
    expect(result.files).toEqual([
      unusable(key, PRIVATE_KEY_REASON),
      unusable(notes, NOT_A_CERTIFICATE_REASON),
      unusable(missing, 'cannot be read (ENOENT)'),
    ]);
    expect(result.detail).toBe(
      `fail (${key}: ${PRIVATE_KEY_REASON}; ${notes}: ${NOT_A_CERTIFICATE_REASON}; ${missing}: cannot be read (ENOENT))`,
    );

    // Nothing of either file: not a line of the key, not a word of the notes.
    const printed = [JSON.stringify(result), ...result.files.map(certificateFileLine)].join('\n');
    for (const line of pem.split('\n').filter((l) => l.length > 0)) {
      expect(printed).not.toContain(line);
    }
    expect(printed).not.toContain('-----BEGIN');
    expect(printed).not.toContain('SECRET-NOTE');
  });
});

// ---------------------------------------------------------------------------------------------
// Real certificates: the two synthetic fixtures of test/fixtures/cert (rules in its README).
// ---------------------------------------------------------------------------------------------

const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cert');
const NODE_A = join(CERT_DIR, 'node-a.crt');
const NODE_B = join(CERT_DIR, 'node-b.crt');
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

describe('the certificate fixtures', () => {
  it('hold no private key, and none is named .pem or .key', () => {
    // The working tree, minus what macOS adds when the folder is opened in Finder.
    const names = readdirSync(CERT_DIR)
      .filter((name) => name !== '.DS_Store')
      .sort();
    expect(names).toEqual(['README.md', 'node-a.crt', 'node-b.crt']);
    for (const name of names) {
      expect(name).not.toMatch(/\.(pem|key)$/i);
      const text = readFileSync(join(CERT_DIR, name), 'latin1');
      // No file, the README included, holds a PEM private key block of any kind.
      expect(text, name).not.toMatch(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
      if (!name.endsWith('.crt')) continue;
      // A certificate file holds one certificate block and never names a private key at all.
      expect(text, name).not.toContain('PRIVATE KEY');
      expect(text.match(/-----BEGIN [A-Z0-9 ]+-----/g), name).toEqual([
        '-----BEGIN CERTIFICATE-----',
      ]);
    }
  });

  it('are read as two different certificates with a far notAfter and a dummy CN', async () => {
    const a = await loadCertificate(NODE_A);
    const b = await loadCertificate(NODE_B);
    if (!a.ok || !b.ok) throw new Error('the fixtures must be readable certificates');
    expect(a.notAfter.toISOString()).toBe('2099-12-31T23:59:59.000Z');
    expect(b.notAfter.toISOString()).toBe('2098-12-31T23:59:59.000Z');
    expect(a.commonName).toBe('test-node-a');
    expect(b.commonName).toBe('test-node-b');
    expect(a.fingerprint256).toMatch(FINGERPRINT);
    expect(b.fingerprint256).toMatch(FINGERPRINT);
    expect(a.fingerprint256).not.toBe(b.fingerprint256);
    expect(a.fingerprint256).toBe(new X509Certificate(readFileSync(NODE_A)).fingerprint256);
  });

  it('have a validTo text that parses to the notAfter validToDate gives (Node.js 22.10 or newer)', () => {
    for (const file of [NODE_A, NODE_B]) {
      const cert = new X509Certificate(readFileSync(file));
      const parsed = parseX509Time(cert.validTo);
      expect(parsed, cert.validTo).not.toBeNull();
      // Absent before Node.js 22.10, whatever the type says.
      const native = (cert as { validToDate?: Date }).validToDate;
      if (native !== undefined) expect(parsed).toEqual(native);
    }
  });
});

/** The DER bytes of a fixture (the base64 body of its PEM block). */
function derOf(file: string): Buffer {
  const body = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('-----'))
    .join('');
  return Buffer.from(body, 'base64');
}

/** One DER element: tag, length, content. */
function der(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const header = n < 0x80 ? [tag, n] : n < 0x100 ? [tag, 0x81, n] : [tag, 0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from(header), content]);
}

/** Where the element at `offset` starts, where its content starts, and where it ends. */
function derAt(bytes: Buffer, offset: number): { start: number; content: number; end: number } {
  const first = bytes[offset + 1] ?? 0;
  let length = first;
  let header = 2;
  if (first & 0x80) {
    header = 2 + (first & 0x7f);
    length = 0;
    for (let i = 2; i < header; i++) length = (length << 8) | (bytes[offset + i] ?? 0);
  }
  return { start: offset, content: offset + header, end: offset + header + length };
}

const OID_CN = [0x55, 0x04, 0x03];
const OID_O = [0x55, 0x04, 0x0a];
const attribute = (oid: number[], value: string) =>
  der(0x30, Buffer.concat([der(0x06, Buffer.from(oid)), der(0x0c, Buffer.from(value))]));
const rdn = (...attributes: Buffer[]) => der(0x31, Buffer.concat(attributes));

/**
 * node-a with another subject: the sixth field of its TBSCertificate replaced. The signature no
 * longer matches, which parsing does not look at; nothing here is a certificate of anything.
 */
function nodeAWithSubject(...rdns: Buffer[]): Buffer {
  const original = derOf(NODE_A);
  const certificate = derAt(original, 0);
  const tbs = derAt(original, certificate.content);
  const fields: Buffer[] = [];
  for (let offset = tbs.content; offset < tbs.end; ) {
    const field = derAt(original, offset);
    fields.push(original.subarray(field.start, field.end));
    offset = field.end;
  }
  fields[5] = der(0x30, Buffer.concat(rdns));
  return der(
    0x30,
    Buffer.concat([der(0x30, Buffer.concat(fields)), original.subarray(tbs.end, certificate.end)]),
  );
}

describe('unusual certificates, built in memory from node-a', () => {
  it('fails a notAfter that is not a real time, instead of trusting a date from node:crypto', () => {
    const bytes = derOf(NODE_A);
    const position = bytes.indexOf('20991231235959Z');
    expect(position).toBeGreaterThan(0);
    // Each has the length of the original, so no DER length changes.
    for (const impossible of ['20990230000000Z', '20991231235960Z', '20991231240000Z']) {
      bytes.write(impossible, position, 'latin1');
      expect(new X509Certificate(bytes).validTo).toBe('Bad time value');
      // Parsed again and again: node:crypto's validToDate is not stable for such a certificate.
      for (let i = 0; i < 20; i++) {
        expect(parseCertificate(bytes)).toEqual({ ok: false, reason: NO_EXPIRY_REASON });
      }
    }
    const file = describeCertificateFile(
      'odd.crt',
      parseCertificate(bytes),
      new Date('2026-10-04T00:00:00.000Z'),
      30,
    );
    expect(file).toEqual(unusable('odd.crt', NO_EXPIRY_REASON));
  });

  it('takes the CN alone from a subject that has more than a CN', () => {
    const cn = (bytes: Buffer) => {
      const loaded = parseCertificate(bytes);
      if (!loaded.ok) throw new Error(loaded.reason);
      return loaded.commonName;
    };
    // One RDN with two attributes: node:crypto prints its subject as "CN=a + O=b".
    const multi = nodeAWithSubject(rdn(attribute(OID_CN, 'a'), attribute(OID_O, 'b')));
    expect(new X509Certificate(multi).subject).toBe('CN=a + O=b');
    expect(cn(multi)).toBe('a');
    expect(cn(nodeAWithSubject(rdn(attribute(OID_O, 'b')), rdn(attribute(OID_CN, 'a'))))).toBe('a');
    expect(
      cn(nodeAWithSubject(rdn(attribute(OID_CN, 'first')), rdn(attribute(OID_CN, 'second')))),
    ).toBe('first');
    // A value is reported as written, not in the escaped form of the subject text.
    expect(cn(nodeAWithSubject(rdn(attribute(OID_CN, 'a,b + O=x'))))).toBe('a,b + O=x');
    // A line break inside the CN cannot start a second line of output.
    expect(cn(nodeAWithSubject(rdn(attribute(OID_CN, `one${at(0x0a)}CN=two`))))).toBe('one CN=two');
  });

  it('has no CN for a subject without one, and still judges the certificate', () => {
    for (const bytes of [nodeAWithSubject(rdn(attribute(OID_O, 'org'))), nodeAWithSubject()]) {
      expect(parseCertificate(bytes)).toMatchObject({
        ok: true,
        commonName: null,
        notAfter: new Date('2099-12-31T23:59:59.000Z'),
      });
    }
  });

  it('finds no certificate in a megabyte of BEGIN lines without an END, in linear time', () => {
    const marker = '-----BEGIN CERTIFICATE-----';
    const flood = Buffer.from(marker.repeat(Math.floor(MAX_CERT_FILE_BYTES / marker.length)));
    const started = performance.now();
    expect(parseCertificate(flood)).toEqual({ ok: false, reason: NOT_A_CERTIFICATE_REASON });
    // A search that restarts at every BEGIN takes many seconds on this input.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('certificate files in other forms', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbol-mcp-cert-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const fingerprintOf = (file: string) => new X509Certificate(readFileSync(file)).fingerprint256;

  it('uses the first certificate of a file that holds several (node.full.crt.pem)', async () => {
    const a = readFileSync(NODE_A, 'utf8');
    const b = readFileSync(NODE_B, 'utf8');
    const full = join(dir, 'node-full.crt');
    writeFileSync(full, `${a}${b}`);
    expect(await loadCertificate(full)).toMatchObject({
      ok: true,
      fingerprint256: fingerprintOf(NODE_A),
      commonName: 'test-node-a',
    });
    writeFileSync(full, `some text before\n${b}\n${a}`);
    expect(await loadCertificate(full)).toMatchObject({
      ok: true,
      fingerprint256: fingerprintOf(NODE_B),
      commonName: 'test-node-b',
    });
  });

  it('reads a DER file as the same certificate', async () => {
    const file = join(dir, 'node-a.der');
    writeFileSync(file, derOf(NODE_A));
    expect(await loadCertificate(file)).toMatchObject({
      ok: true,
      fingerprint256: fingerprintOf(NODE_A),
    });
  });

  it('refuses a certificate that has a private key in the same file', async () => {
    const pem = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const both = join(dir, 'certificate-and-key.txt');
    writeFileSync(both, `${readFileSync(NODE_A, 'utf8')}${pem}`);
    expect(await loadCertificate(both)).toEqual({ ok: false, reason: PRIVATE_KEY_REASON });
  });
});

describe('checkCertificates on the fixtures, with the clock set relative to notAfter', () => {
  const A_NOT_AFTER = new Date('2099-12-31T23:59:59.000Z').getTime();
  const B_NOT_AFTER = new Date('2098-12-31T23:59:59.000Z').getTime();
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbol-mcp-cert-'));
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });
  /** The check as the CLI runs it, reading the (fake) system clock. */
  const check = (paths: readonly string[], warnDays = DEFAULT_CERT_WARN_DAYS) =>
    checkCertificates(paths, warnDays, new Date());
  /** A copy of node-a at another path, as the REST gateway's copy is. */
  function copyOfA(): string {
    const copy = join(dir, 'rest-gateway-copy.crt');
    writeFileSync(copy, readFileSync(NODE_A));
    return copy;
  }

  it('is ok at 30 days left and warns one millisecond later', async () => {
    vi.setSystemTime(A_NOT_AFTER - 30 * DAY_MS);
    expect(await check([NODE_A])).toMatchObject({
      status: 'ok',
      detail: 'ok (1 file, expires 2099-12-31, 30 days left)',
      hint: null,
      files: [{ path: NODE_A, status: 'ok', daysLeft: 30, notAfter: '2099-12-31T23:59:59.000Z' }],
    });
    vi.setSystemTime(A_NOT_AFTER - 30 * DAY_MS + 1);
    expect(await check([NODE_A])).toMatchObject({
      status: 'warn',
      detail: 'warn (1 file, expires 2099-12-31, 29 days left)',
      files: [{ status: 'warn', daysLeft: 29 }],
    });
  });

  it('warns at 7 days left and fails one millisecond later', async () => {
    vi.setSystemTime(A_NOT_AFTER - 7 * DAY_MS);
    expect(await check([NODE_A])).toMatchObject({
      status: 'warn',
      detail: 'warn (1 file, expires 2099-12-31, 7 days left)',
    });
    vi.setSystemTime(A_NOT_AFTER - 7 * DAY_MS + 1);
    expect(await check([NODE_A])).toMatchObject({
      status: 'fail',
      detail: 'fail (1 file, expires 2099-12-31, 6 days left)',
      files: [{ status: 'fail', daysLeft: 6 }],
    });
  });

  it('fails on the last day with 0 days left, and as expired after notAfter', async () => {
    vi.setSystemTime(A_NOT_AFTER - DAY_MS + 1);
    expect(await check([NODE_A])).toMatchObject({
      status: 'fail',
      detail: 'fail (1 file, expires 2099-12-31, 0 days left)',
      files: [{ daysLeft: 0 }],
    });
    vi.setSystemTime(A_NOT_AFTER);
    expect((await check([NODE_A])).detail).toBe('fail (1 file, expires 2099-12-31, 0 days left)');
    vi.setSystemTime(A_NOT_AFTER + 1);
    const expired = await check([NODE_A]);
    expect(expired).toMatchObject({
      status: 'fail',
      detail: 'fail (1 file, expired 2099-12-31)',
      files: [{ status: 'fail', daysLeft: -1 }],
    });
    expect(expired.files.map(certificateFileLine)).toEqual([
      `${NODE_A}: fail, expired 2099-12-31T23:59:59.000Z, sha256 ${expired.files[0]?.fingerprint256}`,
    ]);
    vi.setSystemTime(A_NOT_AFTER + 400 * DAY_MS);
    expect(await check([NODE_A])).toMatchObject({ status: 'fail', files: [{ daysLeft: -400 }] });
  });

  it('moves the warn threshold with --cert-warn-days and leaves the 7 days of fail', async () => {
    vi.setSystemTime(A_NOT_AFTER - 60 * DAY_MS + 1);
    expect((await check([NODE_A])).status).toBe('ok');
    expect((await check([NODE_A], 60)).status).toBe('warn');
    vi.setSystemTime(A_NOT_AFTER - 7 * DAY_MS + 1);
    expect((await check([NODE_A], 1)).status).toBe('fail');
    vi.setSystemTime(A_NOT_AFTER - 7 * DAY_MS);
    expect((await check([NODE_A], 1)).status).toBe('ok');
  });

  it('is ok for node-a and a copy of node-a, and judges both by the days left', async () => {
    const copy = copyOfA();
    vi.setSystemTime(A_NOT_AFTER - 366 * DAY_MS);
    const ok = await check([NODE_A, copy]);
    expect(ok).toMatchObject({
      status: 'ok',
      detail: 'ok (2 files, expires 2099-12-31, 366 days left)',
      files: [
        { path: NODE_A, status: 'ok', commonName: 'test-node-a' },
        { path: copy, status: 'ok', commonName: 'test-node-a' },
      ],
    });
    expect(ok.files[0]?.fingerprint256).toBe(ok.files[1]?.fingerprint256);
    vi.setSystemTime(A_NOT_AFTER - 16 * DAY_MS);
    expect((await check([NODE_A, copy])).detail).toBe(
      'warn (2 files, expires 2099-12-31, 16 days left)',
    );
    vi.setSystemTime(A_NOT_AFTER + DAY_MS);
    expect((await check([NODE_A, copy])).detail).toBe('fail (2 files, expired 2099-12-31)');
  });

  it('warns for node-a and node-b, which are not copies, and names both', async () => {
    vi.setSystemTime(B_NOT_AFTER - 400 * DAY_MS);
    const differ = await check([NODE_A, NODE_B]);
    expect(differ).toMatchObject({
      status: 'warn',
      detail: `warn (copies differ: ${NODE_A} vs ${NODE_B})`,
      files: [
        { path: NODE_A, status: 'ok', daysLeft: 765 },
        { path: NODE_B, status: 'ok', daysLeft: 400 },
      ],
    });
    expect(differ.files.map(certificateFileLine)).toEqual([
      `${NODE_A}: ok, expires 2099-12-31T23:59:59.000Z, 765 days left, sha256 ${differ.files[0]?.fingerprint256}`,
      `${NODE_B}: ok, expires 2098-12-31T23:59:59.000Z, 400 days left, sha256 ${differ.files[1]?.fingerprint256}`,
    ]);
    // Three files, two certificates: the copy of node-a is not named again.
    expect((await check([NODE_A, copyOfA(), NODE_B])).detail).toBe(
      `warn (copies differ: ${NODE_A} vs ${NODE_B})`,
    );
  });

  it('takes the worst of the files and the comparison as the verdict', async () => {
    // The copy that was not renewed (node-b) nears its end while node-a has a year more.
    vi.setSystemTime(B_NOT_AFTER - 10 * DAY_MS);
    expect(await check([NODE_A, NODE_B])).toMatchObject({
      status: 'warn',
      detail: `warn (${NODE_B}: expires 2098-12-31, 10 days left; copies differ: ${NODE_A} vs ${NODE_B})`,
    });
    vi.setSystemTime(B_NOT_AFTER - 3 * DAY_MS);
    expect(await check([NODE_A, NODE_B])).toMatchObject({
      status: 'fail',
      detail: `fail (${NODE_B}: expires 2098-12-31, 3 days left; copies differ: ${NODE_A} vs ${NODE_B})`,
      files: [{ status: 'ok' }, { status: 'fail' }],
    });
    vi.setSystemTime(B_NOT_AFTER + DAY_MS);
    expect((await check([NODE_A, NODE_B])).detail).toBe(
      `fail (${NODE_B}: expired 2098-12-31; copies differ: ${NODE_A} vs ${NODE_B})`,
    );
  });

  it('fails a file that cannot be used and still judges the certificate next to it', async () => {
    vi.setSystemTime(A_NOT_AFTER - 366 * DAY_MS);
    const missing = join(dir, 'missing.crt');
    const result = await check([missing, NODE_A]);
    expect(result).toMatchObject({
      status: 'fail',
      detail: `fail (${missing}: cannot be read (ENOENT))`,
      files: [
        { path: missing, status: 'fail', reason: 'cannot be read (ENOENT)' },
        { path: NODE_A, status: 'ok', daysLeft: 366, reason: null },
      ],
    });
  });

  it('reports the path as given, and nothing of the certificate but the listed values', async () => {
    vi.setSystemTime(A_NOT_AFTER - 366 * DAY_MS);
    const given = relative(process.cwd(), NODE_A);
    const result = await check([given]);
    expect(result.files).toEqual([
      {
        path: given,
        status: 'ok',
        notAfter: '2099-12-31T23:59:59.000Z',
        daysLeft: 366,
        fingerprint256: new X509Certificate(readFileSync(NODE_A)).fingerprint256,
        commonName: 'test-node-a',
        reason: null,
      },
    ]);
    const printed = [JSON.stringify(result), ...result.files.map(certificateFileLine)].join('\n');
    for (const line of readFileSync(NODE_A, 'utf8').split('\n')) {
      if (line.length > 0) expect(printed).not.toContain(line);
    }
  });
});
