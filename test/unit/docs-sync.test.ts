/**
 * Keeps the user-facing documents in step with the code: every registered tool and every
 * environment variable is documented in both READMEs, server.json (the MCP Registry entry)
 * declares exactly the variables the server reads, its versions and those of package-lock.json
 * follow package.json, and the two READMEs keep the same section structure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_VARS } from '../../src/cli.js';
import { TOOLS } from '../../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const READMES = ['README.md', 'README.ja.md'] as const;

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

interface RegistryEntry {
  version: string;
  packages: Array<{ version: string; environmentVariables: Array<{ name: string }> }>;
}

interface Lockfile {
  version: string;
  packages: Record<string, { version?: string }>;
}

const serverJson = JSON.parse(read('server.json')) as RegistryEntry;
const packageJson = JSON.parse(read('package.json')) as { version: string };
const packageLock = JSON.parse(read('package-lock.json')) as Lockfile;

/** Headings (any level) outside fenced code blocks. */
function headings(markdown: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence && /^#{1,6} /.test(line)) {
      found.push(line);
    }
  }
  return found;
}

/** `## ` headings outside fenced code blocks. */
function level2Headings(markdown: string): string[] {
  return headings(markdown).filter((line) => line.startsWith('## '));
}

describe('documentation stays in sync with the code', () => {
  for (const file of READMES) {
    it(`${file} names every registered tool`, () => {
      const text = read(file);
      expect(TOOLS.map((t) => t.name).filter((name) => !text.includes(name))).toEqual([]);
    });

    it(`${file} names every environment variable`, () => {
      const text = read(file);
      expect(ENV_VARS.map((v) => v.name).filter((name) => !text.includes(name))).toEqual([]);
    });
  }

  it('server.json declares exactly the environment variables the server reads', () => {
    const declared = serverJson.packages[0]?.environmentVariables.map((v) => v.name) ?? [];
    expect(new Set(declared)).toEqual(new Set(ENV_VARS.map((v) => v.name)));
    expect(declared).toHaveLength(ENV_VARS.length);
  });

  it('server.json versions match package.json', () => {
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages[0]?.version).toBe(packageJson.version);
  });

  it('package-lock.json versions match package.json', () => {
    // The root version and the root package entry (key ""), both written by npm install.
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages['']?.version).toBe(packageJson.version);
  });

  it('README.md and README.ja.md have the same number of sections', () => {
    const en = level2Headings(read('README.md'));
    const ja = level2Headings(read('README.ja.md'));
    expect(en.length).toBeGreaterThan(0);
    expect(ja).toHaveLength(en.length);
  });

  for (const file of READMES) {
    it(`${file} has a section on the Claude Desktop bundle (.mcpb)`, () => {
      expect(headings(read(file)).some((h) => h.includes('.mcpb'))).toBe(true);
    });
  }
});
