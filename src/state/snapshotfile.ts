/**
 * The only file in src/ that touches the file system. symbol_harvester_watch keeps one snapshot
 * file per node under SYMBOL_STATE_DIR (DESIGN-BRIEF §2-9): public keys, heights and timestamps
 * only, never secrets. Reads never throw (a bad file is reported as corrupt and treated as a
 * baseline); writes go to a temporary file in the same directory and are renamed into place,
 * never through a symlink, and never anywhere but the resolved target.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  assertInsideDir,
  type HarvesterState,
  HarvesterStateSchema,
  type StateFileTarget,
} from '../domain/harvesterwatch.js';

export type StateFileOperation = 'mkdir' | 'write' | 'rename' | 'read';

export class StateFileError extends Error {
  readonly code: string;
  readonly path: string;
  readonly operation: StateFileOperation;

  constructor(operation: StateFileOperation, path: string, cause: unknown) {
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : 'UNKNOWN';
    super(`could not ${operation} ${path} (${code})`);
    this.name = 'StateFileError';
    this.code = code;
    this.path = path;
    this.operation = operation;
  }
}

export interface ReadResult {
  readonly state: HarvesterState | null;
  /** True when a file exists but could not be used. */
  readonly corrupt: boolean;
  readonly reason: string | null;
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : 'UNKNOWN';
}

/** Missing file -> no state. Symlink, directory, invalid JSON or wrong shape -> corrupt. Never throws. */
export async function readSnapshotFile(file: string): Promise<ReadResult> {
  let text: string;
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) return { state: null, corrupt: true, reason: 'not a regular file' };
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { state: null, corrupt: false, reason: null };
    return { state: null, corrupt: true, reason: `read failed (${errorCode(err)})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: null, corrupt: true, reason: 'invalid JSON' };
  }
  const parsed = HarvesterStateSchema.safeParse(json);
  if (!parsed.success) return { state: null, corrupt: true, reason: 'unexpected shape' };
  return { state: parsed.data, corrupt: false, reason: null };
}

/**
 * Creates the directory (mode 0700; an existing directory keeps its mode), writes the state to a
 * temporary file next to the target (mode 0600, exclusive create) and renames it into place.
 * On POSIX the rename is atomic; on Windows it replaces the target but may fail with EPERM while
 * the file is open. On any failure the temporary file is removed and a StateFileError is thrown.
 */
export async function writeSnapshotFileAtomic(
  target: StateFileTarget,
  state: HarvesterState,
): Promise<void> {
  const tmp = `${target.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  assertInsideDir(target.dir, tmp);
  try {
    await mkdir(target.dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new StateFileError('mkdir', target.dir, err);
  }
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new StateFileError('write', tmp, err);
  }
  try {
    await rename(tmp, target.file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new StateFileError('rename', target.file, err);
  }
}
