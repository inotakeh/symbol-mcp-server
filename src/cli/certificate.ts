/**
 * The `certificate` item of `symbol-mcp-server check`. It is the one item that does not re-read a
 * tool's verdict: no REST endpoint shows a node's certificate files, so the check reads the files
 * named with --cert on this machine and judges them here (DESIGN-BRIEF §13). It contacts nothing.
 *
 * Safety line: a file whose content contains the PEM label of a private key ("PRIVATE KEY") is
 * refused before anything is parsed, and of a file's content only the expiry date, the SHA-256
 * fingerprint and the subject's common name ever reach the output.
 */
import { X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as z from 'zod/v4';
import { sanitizeUntrusted, toSingleLine } from '../domain/sanitize.js';

export const DEFAULT_CERT_WARN_DAYS = 30;
export const MIN_CERT_WARN_DAYS = 1;
/** Fewer whole days left than this, or expired: fail. Fixed; --cert-warn-days does not move it. */
export const CERT_FAIL_DAYS = 7;
/** A certificate, or a bundle of a few, is some kilobytes; a larger file is not read. */
export const MAX_CERT_FILE_BYTES = 1_048_576;
const DAY_MS = 86_400_000;
/** The upper bound of a common name in X.509 (ub-common-name). */
const MAX_COMMON_NAME_LENGTH = 64;

export const PRIVATE_KEY_REASON = 'a private key was passed; pass the certificate (.crt.pem)';
export const NOT_A_CERTIFICATE_REASON = 'not a certificate (no X.509 certificate could be parsed)';
export const NOT_A_FILE_REASON = 'not a regular file';
export const TOO_LARGE_REASON = 'too large to be a certificate file';
export const NO_EXPIRY_REASON = 'the expiry date of the certificate could not be read';

export type CertificateStatus = 'ok' | 'warn' | 'fail';

/** One --cert file in the report. Everything but `path`, `status` and `reason` comes from the certificate. */
export interface CertificateFile {
  /** The path as given on the command line, made one printable line. */
  readonly path: string;
  readonly status: CertificateStatus;
  /** ISO 8601, UTC. */
  readonly notAfter: string | null;
  /** Whole days from now to notAfter, rounded down: 0 on the last day, negative once expired. */
  readonly daysLeft: number | null;
  /** SHA-256 fingerprint as node:crypto prints it: upper-case hex pairs joined by colons. */
  readonly fingerprint256: string | null;
  readonly commonName: string | null;
  /** Why the file could not be used as a certificate; null when it was read. */
  readonly reason: string | null;
}

export const CertificateFileSchema = z.object({
  path: z.string(),
  status: z.enum(['ok', 'warn', 'fail']),
  notAfter: z.union([z.string(), z.null()]),
  daysLeft: z.union([z.number(), z.null()]),
  fingerprint256: z.union([z.string(), z.null()]),
  commonName: z.union([z.string(), z.null()]),
  reason: z.union([z.string(), z.null()]),
});

// ---------------------------------------------------------------------------------------------
// Pure: dates, judgment, wording
// ---------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const X509_TIME = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? (\d{4}) GMT$/;

/**
 * `validTo` of node:crypto as a Date, or null when it is not in the form OpenSSL prints
 * ("Oct  5 02:11:09 2027 GMT": a day below 10 is padded with a space; a fraction of a second, which
 * OpenSSL prints when the certificate has one, is dropped). For a notAfter that is not a real time
 * node:crypto gives "Bad time value", which is null here.
 *
 * This text is the one source of notAfter on every Node.js version. `validToDate` exists only from
 * Node.js 22.10 (`engines` allows 22.0), and for a time that is not valid it can hold an arbitrary
 * date instead of an invalid one.
 */
export function parseX509Time(text: string): Date | null {
  const m = X509_TIME.exec(text);
  if (!m) return null;
  const [, monthName = '', day = '', hour = '', minute = '', second = '', year = ''] = m;
  const month = MONTHS.indexOf(monthName);
  if (month < 0) return null;
  const date = new Date(
    Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)),
  );
  // Date.UTC rolls an impossible value over (Feb 30 becomes Mar 2, 24:00 the next day); such a
  // text is refused instead.
  const two = (n: number) => String(n).padStart(2, '0');
  const written = `${year}-${two(month + 1)}-${two(Number(day))}T${hour}:${minute}:${second}.000Z`;
  return date.toISOString() === written ? date : null;
}

/**
 * The first CN of a certificate's subject, cleaned, or null. `subject` is the subject of
 * `toLegacyObject()`, which gives each attribute on its own and unescaped (a string, or an array
 * when the attribute occurs more than once); the `subject` text of node:crypto joins the attributes
 * of a multi-valued RDN on one line ("CN=a + O=b") and escapes their values.
 */
export function commonNameOf(subject: { readonly CN?: unknown } | null | undefined): string | null {
  const cn = subject?.CN;
  const first: unknown = Array.isArray(cn) ? cn[0] : cn;
  if (typeof first !== 'string') return null;
  // Written by whoever made the certificate: one line, no control or format character, capped.
  const name = sanitizeUntrusted(first, MAX_COMMON_NAME_LENGTH);
  return name === '' ? null : name;
}

/** Whole days from `now` to `notAfter`, rounded down: 0 on the last day, negative once expired. */
export function certificateDaysLeft(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS);
}

/** fail when expired or with fewer than 7 days left, warn with fewer than `warnDays`, else ok. */
export function judgeCertificateExpiry(daysLeft: number, warnDays: number): CertificateStatus {
  if (daysLeft < CERT_FAIL_DAYS) return 'fail';
  return daysLeft < warnDays ? 'warn' : 'ok';
}

export type LoadedCertificate =
  | {
      readonly ok: true;
      readonly notAfter: Date;
      readonly fingerprint256: string;
      readonly commonName: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** A command-line path as one printable line (the report prints it; the file is opened as given). */
function printablePath(path: string): string {
  return toSingleLine(path) || '(unprintable path)';
}

export function describeCertificateFile(
  path: string,
  loaded: LoadedCertificate,
  now: Date,
  warnDays: number,
): CertificateFile {
  if (!loaded.ok) {
    return {
      path: printablePath(path),
      status: 'fail',
      notAfter: null,
      daysLeft: null,
      fingerprint256: null,
      commonName: null,
      reason: loaded.reason,
    };
  }
  const daysLeft = certificateDaysLeft(loaded.notAfter, now);
  return {
    path: printablePath(path),
    status: judgeCertificateExpiry(daysLeft, warnDays),
    notAfter: loaded.notAfter.toISOString(),
    daysLeft,
    fingerprint256: loaded.fingerprint256,
    commonName: loaded.commonName,
    reason: null,
  };
}

/**
 * One path per distinct certificate among the files that were read, in the order given, or null
 * when they are all copies of one certificate (or fewer than two were read).
 */
export function differingCopies(files: readonly CertificateFile[]): readonly string[] | null {
  const firstPath = new Map<string, string>();
  for (const f of files) {
    if (f.fingerprint256 !== null && !firstPath.has(f.fingerprint256)) {
      firstPath.set(f.fingerprint256, f.path);
    }
  }
  return firstPath.size > 1 ? [...firstPath.values()] : null;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "expires <when>, N days left" or "expired <when>"; `when` is the date, or the full time. */
function expiryText(notAfter: string, daysLeft: number, dateOnly: boolean): string {
  const when = dateOnly ? notAfter.slice(0, 10) : notAfter;
  return daysLeft < 0 ? `expired ${when}` : `expires ${when}, ${count(daysLeft, 'day')} left`;
}

const SEVERITY: Record<CertificateStatus, number> = { ok: 0, warn: 1, fail: 2 };

/**
 * The verdict of the item and its one-line answer. The verdict is the worst of the files, and at
 * least warn when the files that were read are not all the same certificate. When every file is a
 * copy of one certificate the line gives the count and the expiry; otherwise it names each file
 * that is not ok and the copies that differ.
 */
export function summarizeCertificates(files: readonly CertificateFile[]): {
  status: CertificateStatus;
  detail: string;
} {
  const differing = differingCopies(files);
  let status: CertificateStatus = differing ? 'warn' : 'ok';
  for (const f of files) {
    if (SEVERITY[f.status] > SEVERITY[status]) status = f.status;
  }
  const first = files[0];
  if (
    first &&
    first.notAfter !== null &&
    first.daysLeft !== null &&
    !differing &&
    files.every((f) => f.fingerprint256 !== null)
  ) {
    const expiry = expiryText(first.notAfter, first.daysLeft, true);
    return { status, detail: `${status} (${count(files.length, 'file')}, ${expiry})` };
  }
  const problems: string[] = [];
  for (const f of files) {
    if (f.status === 'ok') continue;
    const what =
      f.notAfter !== null && f.daysLeft !== null
        ? expiryText(f.notAfter, f.daysLeft, true)
        : (f.reason ?? 'not read');
    problems.push(`${f.path}: ${what}`);
  }
  if (differing) problems.push(`copies differ: ${differing.join(' vs ')}`);
  return { status, detail: `${status} (${problems.join('; ')})` };
}

/** The line of one file in the text report: path, verdict, notAfter, days left, fingerprint. */
export function certificateFileLine(f: CertificateFile): string {
  if (f.notAfter === null || f.daysLeft === null || f.fingerprint256 === null) {
    return `${f.path}: ${f.status}, ${f.reason ?? 'not read'}`;
  }
  const expiry = expiryText(f.notAfter, f.daysLeft, false);
  return `${f.path}: ${f.status}, ${expiry}, sha256 ${f.fingerprint256}`;
}

// ---------------------------------------------------------------------------------------------
// Reading the files
// ---------------------------------------------------------------------------------------------

const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

/** The first PEM certificate block of `text`, or null. Two plain searches: linear in the length. */
function firstPemCertificate(text: string): string | null {
  const start = text.indexOf(PEM_BEGIN);
  if (start < 0) return null;
  const end = text.indexOf(PEM_END, start + PEM_BEGIN.length);
  return end < 0 ? null : text.slice(start, end + PEM_END.length);
}

/**
 * The certificate in the bytes of a file. A file whose content contains "PRIVATE KEY" (the label
 * of every PEM private key) is refused before any parsing. Of a bundle (node.full.crt.pem) the
 * first certificate is used. No error text of the parser is passed on, so nothing of the content
 * can reach the output through it.
 */
export function parseCertificate(bytes: Buffer): LoadedCertificate {
  const text = bytes.toString('latin1');
  if (text.includes('PRIVATE KEY')) return { ok: false, reason: PRIVATE_KEY_REASON };
  let cert: X509Certificate;
  let subject: { readonly CN?: unknown } | null = null;
  try {
    // Without a PEM block the bytes are tried as they are (DER).
    cert = new X509Certificate(firstPemCertificate(text) ?? bytes);
  } catch {
    return { ok: false, reason: NOT_A_CERTIFICATE_REASON };
  }
  try {
    subject = cert.toLegacyObject().subject;
  } catch {
    // A subject that cannot be listed leaves the CN unknown; the certificate is still judged.
  }
  const notAfter = parseX509Time(cert.validTo);
  if (!notAfter) return { ok: false, reason: NO_EXPIRY_REASON };
  return {
    ok: true,
    notAfter,
    fingerprint256: cert.fingerprint256,
    commonName: commonNameOf(subject),
  };
}

/** The `code` of a file system error (ENOENT, EACCES, …); never its message, which holds the path. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error';
}

/**
 * The bytes of a regular file of at most MAX_CERT_FILE_BYTES, or the reason it is not read. The
 * file is opened once and judged by what was opened, so it cannot be swapped between the check
 * and the read; O_NONBLOCK keeps the open of a pipe from waiting for a writer; and never more
 * than the cap plus one byte is read, whatever size the file reports.
 */
async function readCertificateFile(file: string): Promise<Buffer | string> {
  // O_NONBLOCK does not exist on Windows, where opening a pipe by path does not wait either.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    // A directory, a device or a pipe: reading it could block or never end.
    if (!info.isFile()) return NOT_A_FILE_REASON;
    if (info.size > MAX_CERT_FILE_BYTES) return TOO_LARGE_REASON;
    const buffer = Buffer.allocUnsafe(MAX_CERT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_CERT_FILE_BYTES ? TOO_LARGE_REASON : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Reads one file; a relative path is resolved against the current directory. Never throws. */
export async function loadCertificate(path: string): Promise<LoadedCertificate> {
  let bytes: Buffer | string;
  try {
    bytes = await readCertificateFile(resolve(path));
  } catch (err) {
    return { ok: false, reason: `cannot be read (${errorCode(err)})` };
  }
  return typeof bytes === 'string' ? { ok: false, reason: bytes } : parseCertificate(bytes);
}

export interface CertificateCheck {
  readonly status: CertificateStatus;
  readonly detail: string;
  /** Always null: this item has no tool whose advice it could pass on. */
  readonly hint: null;
  readonly files: readonly CertificateFile[];
}

/**
 * Reads and judges every --cert file, in the order given. A file that cannot be read or parsed
 * fails with its reason and the others are still judged.
 */
export async function checkCertificates(
  paths: readonly string[],
  warnDays: number,
  now: Date,
): Promise<CertificateCheck> {
  const files: CertificateFile[] = [];
  for (const path of paths) {
    files.push(describeCertificateFile(path, await loadCertificate(path), now, warnDays));
  }
  return { ...summarizeCertificates(files), hint: null, files };
}
