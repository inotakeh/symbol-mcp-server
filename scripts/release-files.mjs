/**
 * What the release scripts know about the release files, as pure functions: the CHANGELOG.md
 * section of a version, and what stops a version from being released with package.json,
 * package-lock.json, server.json and CHANGELOG.md.
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
