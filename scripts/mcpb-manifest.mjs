#!/usr/bin/env node
/**
 * Writes the manifest.json of a .mcpb bundle: mcpb/manifest.json with the release version and
 * the tools and prompts declared from the packaged server itself, so the list cannot drift from
 * what the server registers.
 *
 *   node scripts/mcpb-manifest.mjs <template> <server-dir> <version> <out>
 *
 * <server-dir> is the staged npm package (with its production node_modules); its dist/server.js
 * exports TOOLS and PROMPTS. Called by scripts/build-mcpb.sh. buildManifest is pure and is
 * unit-tested against the source TOOLS / PROMPTS (test/unit/mcpb-manifest.test.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Placeholder the prompt templates use for their only argument (src/prompts/_shared.ts). */
export const PROMPT_ACCOUNT_TOKEN = '{account}';
/** The same argument in MCPB manifest syntax. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB manifest placeholder syntax, not a JavaScript template
export const MANIFEST_ACCOUNT_TOKEN = '${arguments.account}';

const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs)$/i;

/** First sentence of a description: up to the first ". " that does not end an abbreviation. */
export function firstSentence(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = /[.!?](?=\s|$)/g;
  for (let match = end.exec(flat); match !== null; match = end.exec(flat)) {
    const head = flat.slice(0, match.index);
    if (!ABBREVIATIONS.test(head)) return flat.slice(0, match.index + 1);
  }
  return flat;
}

/**
 * The manifest for one release. Does not modify `template`.
 * @param {Record<string, unknown>} template parsed mcpb/manifest.json
 * @param {{ version: string, tools: ReadonlyArray<{ name: string, description: string }>,
 *   prompts: ReadonlyArray<{ name: string, description: string, template: string }> }} parts
 */
export function buildManifest(template, { version, tools, prompts }) {
  return {
    ...structuredClone(template),
    version,
    tools: tools.map((tool) => ({ name: tool.name, description: firstSentence(tool.description) })),
    prompts: prompts.map((prompt) => ({
      name: prompt.name,
      description: firstSentence(prompt.description),
      arguments: ['account'],
      text: prompt.template.split(PROMPT_ACCOUNT_TOKEN).join(MANIFEST_ACCOUNT_TOKEN),
    })),
  };
}

async function main(args) {
  if (args.length !== 4) {
    console.error('usage: node scripts/mcpb-manifest.mjs <template> <server-dir> <version> <out>');
    return 2;
  }
  const [templatePath, serverDir, version, out] = args;
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const server = await import(pathToFileURL(resolve(join(serverDir, 'dist', 'server.js'))).href);
  if (!Array.isArray(server.TOOLS) || !Array.isArray(server.PROMPTS)) {
    console.error(`mcpb-manifest: ${serverDir}/dist/server.js does not export TOOLS and PROMPTS.`);
    return 1;
  }
  const manifest = buildManifest(template, {
    version,
    tools: server.TOOLS,
    prompts: server.PROMPTS,
  });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(
    `mcpb-manifest: ${manifest.tools.length} tools, ${manifest.prompts.length} prompts, version ${version}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
