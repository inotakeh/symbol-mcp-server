#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section of one released version, without its heading, so the release
 * workflow can use it as the GitHub Release notes.
 *
 *   node scripts/release-notes.mjs 0.7.0 > notes.md
 *
 * The section starts after the line `## [0.7.0] - YYYY-MM-DD` and ends before the next `## [`
 * heading or the link references at the end of the file. Exit codes: 0 printed, 1 no dated
 * section for that version (including [Unreleased]) or an empty one, 2 usage error.
 * Development and CI only; the MCP server never loads this file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md');

const NEXT_SECTION = /^## \[/;
const LINK_REFERENCE = /^\[[^\]]+\]: /;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lines of the section for `version`, trimmed of blank lines at both ends; null if absent. */
function extractSection(markdown, version) {
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

function main(args) {
  if (args.length !== 1 || args[0].trim() === '') {
    console.error('usage: node scripts/release-notes.mjs <version>   (e.g. 0.7.0)');
    return 2;
  }
  const version = args[0];
  const body = extractSection(readFileSync(CHANGELOG, 'utf8'), version);
  if (body === null) {
    console.error(
      `release-notes: CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section. Add the release section before tagging.`,
    );
    return 1;
  }
  if (body.length === 0) {
    console.error(`release-notes: the CHANGELOG.md section for ${version} is empty.`);
    return 1;
  }
  process.stdout.write(`${body.join('\n')}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
