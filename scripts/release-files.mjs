/**
 * What the release scripts know about the release files, as pure functions: the CHANGELOG.md
 * section of a version, what stops a version from being released with package.json,
 * package-lock.json, server.json and CHANGELOG.md, and the versions and the restart banner the
 * definitions check (release-definitions.mjs) works with.
 *
 * This module has no side effects, so scripts/release-notes.mjs and scripts/release-check.mjs can
 * import it and still run their main unconditionally (a gate must not skip itself when it is
 * started through another path), and the unit tests import it directly (types in
 * release-files.d.mts). Development and CI only; the MCP server never loads this file.
 */

const NEXT_SECTION = /^## \[/;
const LINK_REFERENCE = /^\[[^\]]+\]: /;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lines of the CHANGELOG.md section for `version`, trimmed of blank lines at both ends; null if
 * there is no `## [version] - YYYY-MM-DD` heading. The section ends before the next `## [` heading
 * or the link references at the end of the file.
 */
export function extractSection(markdown, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`);
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (NEXT_SECTION.test(line) || LINK_REFERENCE.test(line)) break;
    body.push(line);
  }
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return body;
}

/** A value as a message shows it: strings as they are, anything else as JSON. */
function show(value) {
  return typeof value === 'string' ? value : String(JSON.stringify(value));
}

/**
 * What stops `version` from being released with these files, one sentence each; empty when
 * nothing does:
 * - package.json, package-lock.json (its root and packages[""]) and server.json (its version and
 *   the version of every package) carry the version;
 * - server.json's name is package.json's mcpName, and its npm packages are this package. The MCP
 *   Registry accepts a version only when the npm package's mcpName is the name it is asked to
 *   publish, and a version on npm cannot be changed afterwards;
 * - CHANGELOG.md has a dated section for the version with notes in it (the GitHub Release notes).
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

/**
 * The release note a version needs when its tool or prompt definitions change shape (DESIGN-BRIEF
 * §5): the first line of its CHANGELOG.md section, as 0.9.0 has it.
 */
export const RESTART_BANNER =
  '> **After upgrading, restart your MCP host (Claude Desktop, Claude Code and others).**';

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATED_HEADING = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/;

/** [major, minor, patch] of a release version; null for anything else, a pre-release included. */
export function parseReleaseVersion(version) {
  const match = RELEASE_VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Compares two release versions as numbers (0.10.0 is after 0.9.2): negative, 0 or positive. */
function compareVersions(a, b) {
  const [x, y] = [parseReleaseVersion(a), parseReleaseVersion(b)];
  if (x === null || y === null) throw new Error(`not a release version: ${x === null ? a : b}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The release before `version`: the greatest version with a dated CHANGELOG.md section that is
 * lower than it (so it is found before the new section is written); null when there is none.
 * `version` must be a release version.
 */
export function previousReleaseVersion(changelog, version) {
  let previous = null;
  for (const line of changelog.split(/\r?\n/)) {
    const candidate = DATED_HEADING.exec(line)?.[1];
    if (candidate === undefined || parseReleaseVersion(candidate) === null) continue;
    if (compareVersions(candidate, version) >= 0) continue;
    if (previous === null || compareVersions(candidate, previous) > 0) previous = candidate;
  }
  return previous;
}

/** How `next` moves on from `previous`: 'major', 'minor', 'patch', or 'none' when it is not newer. */
export function versionBump(previous, next) {
  const [a, b] = [parseReleaseVersion(previous), parseReleaseVersion(next)];
  if (a === null || b === null)
    throw new Error(`not a release version: ${a === null ? previous : next}`);
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : 'none';
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : 'none';
  return b[2] > a[2] ? 'patch' : 'none';
}

/** The next minor version after a release version: 0.9.2 -> 0.10.0. */
export function nextMinorVersion(version) {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) throw new Error(`not a release version: ${version}`);
  return `${parsed[0]}.${parsed[1] + 1}.0`;
}

/**
 * True when a CHANGELOG.md section (the lines extractSection returns) starts with the restart
 * banner: its first lines form a blockquote whose text, joined across wrapped lines, starts with
 * the banner's sentence. A later mention, or a note that no restart is needed, does not count.
 */
export function hasRestartBanner(section) {
  const quote = [];
  for (const line of section) {
    if (!line.startsWith('>')) break;
    quote.push(line.replace(/^>\s?/, ''));
  }
  const text = quote.join(' ').replace(/\s+/g, ' ').trim();
  return text.startsWith(RESTART_BANNER.replace(/^>\s?/, ''));
}
