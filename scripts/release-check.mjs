#!/usr/bin/env node
/**
 * Checks that the files of a release agree with each other and with its tag, before anything is
 * published:
 *
 *   node scripts/release-check.mjs 0.9.0 [--previous-definitions <file>]
 *
 * - package.json, package-lock.json (its root and packages[""]) and server.json (its version and
 *   the version of every package) carry the version;
 * - server.json's name is package.json's mcpName, and its npm packages are this package. The MCP
 *   Registry accepts a version only when the npm package's mcpName is the name it is asked to
 *   publish, and a version on npm cannot be changed afterwards;
 * - CHANGELOG.md has a dated section for the version with notes in it (the GitHub Release notes);
 * - the version follows the shape of the definitions (DESIGN-BRIEF §5): the committed snapshot of
 *   the tool and prompt definitions is compared with the one at the tag of the release before it
 *   (`git show v<previous>:<snapshot>`, the greatest dated CHANGELOG.md version below this one).
 *   A shape change needs a minor or major version whose section starts with the restart banner;
 *   descriptive text alone may ship in a patch. One line on stdout always says what was compared
 *   and what changed, also when something else is wrong.
 *
 * `--previous-definitions <file>` compares with that file instead of the tag, for the tests and for
 * a checkout without tags; the release workflow never passes it. The comparison reads the committed
 * snapshot, not the code: the snapshot test (npm test) proves that they agree, and the publish job
 * runs it after this check.
 *
 * The publish job of .github/workflows/release.yml runs it before anything else (its checkout
 * fetches the tags), and maintainers run it before tagging. Each problem is printed on stderr.
 * Exit codes: 0 everything agrees, 1 something does not, 2 usage error. The checks are in
 * release-files.mjs and release-definitions.mjs (pure functions, except readSnapshotAt, which runs
 * `git show`), unit-tested in test/unit/release-check.test.ts and
 * test/unit/release-definitions.test.ts; this file only reads the files and reports, and it always
 * runs, whatever path it is started through. Development and CI only; the MCP server never loads
 * this file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFINITIONS_SNAPSHOT,
  definitionsCheck,
  PREVIOUS_FLAG,
  readSnapshotAt,
  unreadableDefinitions,
} from './release-definitions.mjs';
import { parseReleaseVersion, previousReleaseVersion, releaseProblems } from './release-files.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: node scripts/release-check.mjs <version> [--previous-definitions <file>]   (e.g. 0.9.0)';

function readRepoFile(file) {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** `{ version, previousFile }`, or null for anything else than one version and the one flag. */
function parseArgs(args) {
  let version = null;
  let previousFile = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === PREVIOUS_FLAG || arg.startsWith(`${PREVIOUS_FLAG}=`)) {
      const value = arg === PREVIOUS_FLAG ? args[++i] : arg.slice(PREVIOUS_FLAG.length + 1);
      if (previousFile !== null || value === undefined || value.trim() === '') return null;
      previousFile = value;
    } else if (arg.startsWith('--') || version !== null || arg.trim() === '') {
      return null;
    } else {
      version = arg.replace(/^v/, '');
    }
  }
  return version === null ? null : { version, previousFile };
}

/** The definitions part of the check: `{ verdict, problems }`. */
function checkDefinitions(version, changelog, current, previousFile) {
  if (parseReleaseVersion(version) === null) {
    return {
      verdict: `definitions not compared: ${version} is not a release version.`,
      problems: [
        `${version} is not a release version (major.minor.patch, without a pre-release or build part); the release check does not take pre-releases.`,
      ],
    };
  }
  const previousVersion = previousReleaseVersion(changelog, version);
  if (previousVersion === null) {
    return {
      verdict: `definitions not compared: CHANGELOG.md has no release before ${version}.`,
      problems: [],
    };
  }
  let previous;
  let previousLabel;
  let diffCommand;
  if (previousFile !== null) {
    previousLabel = `${previousFile} (${PREVIOUS_FLAG}, as ${previousVersion})`;
    diffCommand = `diff ${previousFile} ${DEFINITIONS_SNAPSHOT}`;
    try {
      previous = JSON.parse(readFileSync(resolve(previousFile), 'utf8'));
    } catch (err) {
      return {
        verdict: `definitions not compared: ${previousFile} could not be read.`,
        problems: [`cannot read ${PREVIOUS_FLAG} ${previousFile}: ${err.message}`],
      };
    }
  } else {
    const ref = `v${previousVersion}`;
    previousLabel = ref;
    diffCommand = `git diff ${ref} -- ${DEFINITIONS_SNAPSHOT}`;
    const read = readSnapshotAt(ref, DEFINITIONS_SNAPSHOT, REPO_ROOT);
    if (!read.ok) {
      return {
        verdict: `definitions not compared: the definitions of ${previousVersion} could not be read.`,
        problems: [
          unreadableDefinitions(previousVersion, ref, read, {
            inWorkflow: process.env.GITHUB_ACTIONS === 'true',
          }),
        ],
      };
    }
    previous = read.value;
  }
  try {
    return definitionsCheck(version, {
      previousVersion,
      previousLabel,
      previous,
      current,
      changelog,
      diffCommand,
    });
  } catch (err) {
    // Fail closed, but keep the verdict line and the other problems.
    return {
      verdict: 'definitions not compared: the comparison failed.',
      problems: [`the definitions could not be compared: ${err.message}`],
    };
  }
}

function main(args) {
  const parsed = parseArgs(args);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { version, previousFile } = parsed;
  let files;
  let definitions;
  try {
    files = {
      packageJson: JSON.parse(readRepoFile('package.json')),
      packageLock: JSON.parse(readRepoFile('package-lock.json')),
      serverJson: JSON.parse(readRepoFile('server.json')),
      changelog: readRepoFile('CHANGELOG.md'),
    };
    definitions = JSON.parse(readRepoFile(DEFINITIONS_SNAPSHOT));
  } catch (err) {
    console.error(`release-check: cannot read the release files: ${err.message}`);
    return 1;
  }
  const problems = releaseProblems(version, files);
  const checked = checkDefinitions(version, files.changelog, definitions, previousFile);
  process.stdout.write(`release-check: ${checked.verdict}\n`);
  problems.push(...checked.problems);
  for (const problem of problems) {
    for (const line of problem.split('\n')) console.error(`release-check: ${line}`);
  }
  if (problems.length > 0) return 1;
  process.stdout.write(
    `release-check: ${version} in package.json, package-lock.json, server.json and CHANGELOG.md; server.json names ${files.packageJson.name} (${files.serverJson.name}).\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
