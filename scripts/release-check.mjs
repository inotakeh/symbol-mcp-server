#!/usr/bin/env node
/**
 * Checks that the files of a release agree with each other and with its tag, before anything is
 * published:
 *
 *   node scripts/release-check.mjs 0.9.0
 *
 * - package.json, package-lock.json (its root and packages[""]) and server.json (its version and
 *   the version of every package) carry the version;
 * - server.json's name is package.json's mcpName, and its npm packages are this package. The MCP
 *   Registry accepts a version only when the npm package's mcpName is the name it is asked to
 *   publish, and a version on npm cannot be changed afterwards;
 * - CHANGELOG.md has a dated section for the version with notes in it (the GitHub Release notes).
 *
 * The publish job of .github/workflows/release.yml runs it before anything else, and maintainers
 * can run it before tagging. Each problem is printed on stderr. Exit codes: 0 everything agrees,
 * 1 something does not, 2 usage error. The checks are releaseProblems in release-files.mjs, which
 * is unit-tested (test/unit/release-check.test.ts); this file only reads the files and reports,
 * and it always runs, whatever path it is started through. Development and CI only; the MCP
 * server never loads this file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseProblems } from './release-files.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(file) {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function main(args) {
  if (args.length !== 1 || args[0].trim() === '') {
    console.error('usage: node scripts/release-check.mjs <version>   (e.g. 0.9.0)');
    return 2;
  }
  const version = args[0].replace(/^v/, '');
  let files;
  try {
    files = {
      packageJson: JSON.parse(readRepoFile('package.json')),
      packageLock: JSON.parse(readRepoFile('package-lock.json')),
      serverJson: JSON.parse(readRepoFile('server.json')),
      changelog: readRepoFile('CHANGELOG.md'),
    };
  } catch (err) {
    console.error(`release-check: cannot read the release files: ${err.message}`);
    return 1;
  }
  const problems = releaseProblems(version, files);
  for (const problem of problems) console.error(`release-check: ${problem}`);
  if (problems.length > 0) return 1;
  process.stdout.write(
    `release-check: ${version} in package.json, package-lock.json, server.json and CHANGELOG.md; server.json names ${files.packageJson.name} (${files.serverJson.name}).\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
