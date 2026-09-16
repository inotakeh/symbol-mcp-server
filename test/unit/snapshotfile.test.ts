import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HarvesterState,
  resolveStateFile,
  stateFileName,
} from '../../src/domain/harvesterwatch.js';
import {
  readSnapshotFile,
  StateFileError,
  writeSnapshotFileAtomic,
} from '../../src/state/snapshotfile.js';

const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();
const NODE_KEY = H('fixture:node-key');
const posix = process.platform !== 'win32';
const notRoot = process.getuid?.() !== 0;

const STATE: HarvesterState = {
  version: 1,
  nodePublicKey: NODE_KEY,
  snapshots: [{ takenAt: '2026-09-10T03:05:00.000Z', height: 5_763_675, keys: [H('fixture:k')] }],
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'symbol-mcp-state-'));
});
afterEach(() => {
  try {
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      if (lstatSync(p).isDirectory()) chmodSync(p, 0o700);
    }
  } catch {
    // best effort
  }
  rmSync(root, { recursive: true, force: true });
});

describe('readSnapshotFile', () => {
  it('reports a missing file as no state, not as corrupt', async () => {
    await expect(readSnapshotFile(join(root, 'missing.json'))).resolves.toEqual({
      state: null,
      corrupt: false,
      reason: null,
    });
  });
  it('reports invalid JSON, a wrong shape, a directory and a symlink as corrupt', async () => {
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(await readSnapshotFile(bad)).toMatchObject({ corrupt: true, reason: /JSON/ });
    writeFileSync(bad, JSON.stringify({ version: 2 }));
    expect(await readSnapshotFile(bad)).toMatchObject({ corrupt: true, reason: /shape/ });
    const dir = join(root, 'dir.json');
    mkdirSync(dir);
    expect(await readSnapshotFile(dir)).toMatchObject({ corrupt: true, reason: /regular file/ });
    if (posix) {
      const real = join(root, 'real.json');
      writeFileSync(real, JSON.stringify(STATE));
      const link = join(root, 'link.json');
      symlinkSync(real, link);
      expect(await readSnapshotFile(link)).toMatchObject({ corrupt: true, reason: /regular file/ });
    }
  });
  it('parses a valid file', async () => {
    const file = join(root, 'ok.json');
    writeFileSync(file, JSON.stringify(STATE));
    expect(await readSnapshotFile(file)).toEqual({ state: STATE, corrupt: false, reason: null });
  });
});

describe('writeSnapshotFileAtomic', () => {
  it('creates the directory (0700) and the file (0600) and leaves no temporary file', async () => {
    const target = resolveStateFile(join(root, 'state'), NODE_KEY);
    expect(existsSync(target.dir)).toBe(false);
    await writeSnapshotFileAtomic(target, STATE);
    expect(readdirSync(target.dir)).toEqual([stateFileName(NODE_KEY)]);
    expect(JSON.parse(readFileSync(target.file, 'utf8'))).toEqual(STATE);
    if (posix) {
      expect(statSync(target.dir).mode & 0o777).toBe(0o700);
      expect(statSync(target.file).mode & 0o777).toBe(0o600);
    }
  });
  it('keeps the mode of an existing directory and replaces an existing file', async () => {
    const dir = join(root, 'existing');
    mkdirSync(dir, { mode: 0o755 });
    const target = resolveStateFile(dir, NODE_KEY);
    await writeSnapshotFileAtomic(target, STATE);
    const second = { ...STATE, snapshots: [] };
    await writeSnapshotFileAtomic(target, second);
    expect(JSON.parse(readFileSync(target.file, 'utf8'))).toEqual(second);
    expect(readdirSync(dir)).toEqual([stateFileName(NODE_KEY)]);
    if (posix) expect(statSync(dir).mode & 0o777).toBe(0o755);
  });
  it.skipIf(!posix)('replaces a planted symlink instead of writing through it', async () => {
    const outside = join(root, 'outside.json');
    writeFileSync(outside, 'untouched');
    const dir = join(root, 'state');
    mkdirSync(dir);
    const target = resolveStateFile(dir, NODE_KEY);
    symlinkSync(outside, target.file);
    await writeSnapshotFileAtomic(target, STATE);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(lstatSync(target.file).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(target.file, 'utf8'))).toEqual(STATE);
  });
  it.skipIf(!posix || !notRoot)(
    'throws StateFileError and cleans up when the directory is read-only',
    async () => {
      const dir = join(root, 'ro');
      mkdirSync(dir, { mode: 0o500 });
      const target = resolveStateFile(dir, NODE_KEY);
      await expect(writeSnapshotFileAtomic(target, STATE)).rejects.toBeInstanceOf(StateFileError);
      await expect(writeSnapshotFileAtomic(target, STATE)).rejects.toMatchObject({
        code: 'EACCES',
        operation: 'write',
      });
      expect(readdirSync(dir)).toEqual([]);
    },
  );
  it('refuses a target outside its directory before touching the disk', async () => {
    const dir = join(root, 'a');
    await expect(
      writeSnapshotFileAtomic({ dir, file: join(root, 'b', 'x.json') }, STATE),
    ).rejects.toThrow(/outside/);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, 'b'))).toBe(false);
  });
});
