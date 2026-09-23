/**
 * Keeps the user-facing documents in step with the code: every registered tool and every
 * environment variable is documented in both READMEs, server.json (the MCP Registry entry)
 * declares exactly the variables the server reads, its versions follow package.json, and the two
 * READMEs keep the same section structure.
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

const serverJson = JSON.parse(read('server.json')) as RegistryEntry;
const packageJson = JSON.parse(read('package.json')) as { version: string };

/** `## ` headings outside fenced code blocks. */
function level2Headings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence && line.startsWith('## ')) {
      headings.push(line);
    }
  }
  return headings;
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

  it('README.md and README.ja.md have the same number of sections', () => {
    const en = level2Headings(read('README.md'));
    const ja = level2Headings(read('README.ja.md'));
    expect(en.length).toBeGreaterThan(0);
    expect(ja).toHaveLength(en.length);
  });
});
