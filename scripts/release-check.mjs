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
 * 1 something does not, 2 usage error. releaseProblems is pure and is unit-tested
 * (test/unit/release-check.test.ts). Development and CI only; the MCP server never loads this file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractSection } from './release-notes.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A value as a message shows it: strings as they are, anything else as JSON. */
function show(value) {
  return typeof value === 'string' ? value : String(JSON.stringify(value));
}

/**
 * What stops `version` from being released with these files, one sentence each; empty when
 * nothing does.
 * @param {string} version e.g. "0.9.0"
 * @param {{ packageJson: Record<string, any>, packageLock: Record<string, any>,
 *   serverJson: Record<string, any>, changelog: string }} files parsed package.json,
 *   package-lock.json and server.json, and the text of CHANGELOG.md
 * @returns {string[]}
 */
export function releaseProblems(version, { packageJson, packageLock, serverJson, changelog }) {
  const problems = [];
  const expectVersion = (where, actual) => {
    if (actual !== version) problems.push(`${where} is ${show(actual)}, not ${version}.`);
  };
  expectVersion('package.json version', packageJson.version);
  expectVersion('package-lock.json version', packageLock.version);
  expectVersion('package-lock.json packages[""].version', packageLock.packages?.['']?.version);
  expectVersion('server.json version', serverJson.version);
  const packages = Array.isArray(serverJson.packages) ? serverJson.packages : [];
  packages.forEach((entry, i) => {
    expectVersion(`server.json packages[${i}].version`, entry?.version);
  });

  if (serverJson.name !== packageJson.mcpName) {
    problems.push(
      `server.json name ${show(serverJson.name)} is not package.json mcpName ${show(packageJson.mcpName)}; the MCP Registry accepts the npm version only when they are the same.`,
    );
  }
  let npmPackages = 0;
  packages.forEach((entry, i) => {
    if (entry?.registryType !== 'npm') return;
    npmPackages += 1;
    if (entry.identifier !== packageJson.name) {
      problems.push(
        `server.json packages[${i}].identifier is ${show(entry.identifier)}, not package.json name ${show(packageJson.name)}.`,
      );
    }
  });
  if (npmPackages === 0) {
    problems.push(`server.json lists no npm package; it should list ${show(packageJson.name)}.`);
  }

  const notes = extractSection(changelog, version);
  if (notes === null) {
    problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section.`);
  } else if (notes.length === 0) {
    problems.push(`the CHANGELOG.md section for ${version} is empty.`);
  }
  return problems;
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
