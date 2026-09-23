/**
 * mcpb/manifest.json (the .mcpb template) and scripts/mcpb-manifest.mjs (which completes it at
 * build time). No network: the schema below is a transcription, not a download.
 *
 * Schema source: MCPB manifest JSON schema, manifest_version "0.3",
 * https://github.com/modelcontextprotocol/mcpb/blob/257af308122753c311825523d19e8c939aeaccc5/schemas/mcpb-manifest-latest.schema.json
 * (commit of 2025-10-30; identical to main on 2026-09-23). Only the keys this project uses are
 * transcribed, as strict objects, so a misspelt or unknown key fails here as it would there.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  buildManifest,
  firstSentence,
  MANIFEST_ACCOUNT_TOKEN,
  PROMPT_ACCOUNT_TOKEN,
} from '../../scripts/mcpb-manifest.mjs';
import { ENV_VARS } from '../../src/cli.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, loadConfig } from '../../src/config.js';
import { PROMPTS, TOOLS } from '../../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const UserConfigEntrySchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const ManifestSchema = z.strictObject({
  manifest_version: z.literal('0.3'),
  name: z.string(),
  display_name: z.string().optional(),
  version: z.string(),
  description: z.string(),
  long_description: z.string().optional(),
  author: z.strictObject({
    name: z.string(),
    email: z.email().optional(),
    url: z.url().optional(),
  }),
  repository: z.strictObject({ type: z.string(), url: z.url() }).optional(),
  homepage: z.url().optional(),
  documentation: z.url().optional(),
  support: z.url().optional(),
  icon: z.string().optional(),
  server: z.strictObject({
    type: z.enum(['python', 'node', 'binary']),
    entry_point: z.string(),
    mcp_config: z.strictObject({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  }),
  tools: z
    .array(z.strictObject({ name: z.string(), description: z.string().optional() }))
    .optional(),
  prompts: z
    .array(
      z.strictObject({
        name: z.string(),
        description: z.string().optional(),
        arguments: z.array(z.string()).optional(),
        text: z.string(),
      }),
    )
    .optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  compatibility: z
    .strictObject({
      claude_desktop: z.string().optional(),
      platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).optional(),
      runtimes: z
        .strictObject({ python: z.string().optional(), node: z.string().optional() })
        .optional(),
    })
    .optional(),
  user_config: z.record(z.string(), UserConfigEntrySchema).optional(),
});

type Manifest = z.infer<typeof ManifestSchema>;

const templateText = read('mcpb/manifest.json');
const template = ManifestSchema.parse(JSON.parse(templateText));
const env = template.server.mcp_config.env ?? {};
const userConfig = template.user_config ?? {};
const PLACEHOLDER = /^\$\{user_config\.([a-z][a-z0-9_]*)\}$/;

/** The user_config key an environment variable is filled from. */
function keyFor(variable: string): string {
  const match = PLACEHOLDER.exec(env[variable] ?? '');
  if (!match?.[1]) throw new Error(`${variable} is not mapped to a user_config value`);
  return match[1];
}

/** What a host passes when the user fills in only the required fields (defaults applied). */
function envWithDefaults(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const variable of Object.keys(env)) {
    const key = keyFor(variable);
    const value = values[key] ?? userConfig[key]?.default;
    if (value === undefined) throw new Error(`${key} has neither a value nor a default`);
    out[variable] = String(value);
  }
  return out;
}

describe('mcpb/manifest.json', () => {
  it('matches the MCPB 0.3 manifest schema', () => {
    expect(ManifestSchema.safeParse(JSON.parse(templateText)).success).toBe(true);
  });

  it('describes this package', () => {
    const pkg = JSON.parse(read('package.json')) as {
      name: string;
      license: string;
      engines: { node: string };
    };
    const registry = JSON.parse(read('server.json')) as { description: string };
    expect(template.name).toBe(pkg.name);
    expect(template.license).toBe(pkg.license);
    expect(template.description).toBe(registry.description);
    expect(template.compatibility?.runtimes?.node).toBe(pkg.engines.node);
    expect(template.version).toBe('0.0.0'); // placeholder, replaced by the build
    expect(template.long_description).toMatch(/read-only/i);
    expect(template.long_description).toMatch(/private key/);
    expect(template.long_description).toMatch(/only to the Symbol node you configure/);
  });

  it('starts the packaged entry point with node and nothing fixed in the configuration', () => {
    const { server } = template;
    expect(server.type).toBe('node');
    expect(server.entry_point).toBe('server/dist/index.js');
    expect(server.mcp_config.command).toBe('node');
    expect(server.mcp_config.args).toEqual([`\${__dirname}/${server.entry_point}`]);
    for (const [variable, value] of Object.entries(env)) {
      expect(value, variable).toMatch(PLACEHOLDER);
    }
  });

  it('maps user_config onto exactly the environment variables the server reads', () => {
    expect(Object.keys(env).sort()).toEqual(ENV_VARS.map((v) => v.name).sort());
    const referenced = Object.keys(env).map(keyFor);
    expect(new Set(referenced).size).toBe(referenced.length);
    expect(referenced.sort()).toEqual(Object.keys(userConfig).sort());
  });

  it('requires only the node URL and gives every optional field a default', () => {
    for (const variable of ENV_VARS) {
      const entry = userConfig[keyFor(variable.name)];
      expect(entry?.required ?? false, variable.name).toBe(variable.required);
      if (!variable.required) expect(entry?.default, variable.name).not.toBeUndefined();
    }
    expect(ENV_VARS.filter((v) => v.required).map((v) => v.name)).toEqual(['SYMBOL_NODE_URL']);
  });

  it('loads as the plain configuration when only the node URL is filled in', () => {
    const nodeUrlKey = keyFor('SYMBOL_NODE_URL');
    const config = loadConfig(envWithDefaults({ [nodeUrlKey]: 'https://node.example:3001' }));
    expect(config).toEqual(loadConfig({ SYMBOL_NODE_URL: 'https://node.example:3001' }));
  });

  it('bounds the request timeout like the server does', () => {
    const entry = userConfig[keyFor('SYMBOL_REQUEST_TIMEOUT_MS')];
    expect(entry).toMatchObject({ type: 'number', default: DEFAULT_REQUEST_TIMEOUT_MS });
    const base = { SYMBOL_NODE_URL: 'https://node.example:3001' };
    const at = (ms: number) => () => loadConfig({ ...base, SYMBOL_REQUEST_TIMEOUT_MS: String(ms) });
    expect(at(entry?.min ?? Number.NaN)).not.toThrow();
    expect(at(entry?.max ?? Number.NaN)).not.toThrow();
    expect(at((entry?.min ?? 0) - 1)).toThrow();
    expect(at((entry?.max ?? 0) + 1)).toThrow();
  });

  it('uses a directory picker for the state directory', () => {
    expect(userConfig[keyFor('SYMBOL_STATE_DIR')]?.type).toBe('directory');
  });

  it('ships a 512x512 PNG icon', () => {
    expect(template.icon).toBe('icon.png');
    const png = readFileSync(join(ROOT, 'mcpb', 'icon.png'));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });
});

describe('scripts/mcpb-manifest.mjs', () => {
  const built = buildManifest(JSON.parse(templateText), {
    version: '1.2.3',
    tools: TOOLS,
    prompts: PROMPTS,
  });

  it('produces a manifest that matches the schema', () => {
    const parsed: Manifest = ManifestSchema.parse(built);
    expect(parsed.version).toBe('1.2.3');
  });

  it('declares every registered tool and prompt, in registration order', () => {
    expect(built.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(built.prompts.map((p) => p.name)).toEqual(PROMPTS.map((p) => p.name));
  });

  it('uses the first sentence of each description', () => {
    for (const [i, tool] of built.tools.entries()) {
      const full = (TOOLS[i]?.description ?? '').replace(/\s+/g, ' ').trim();
      expect(full.startsWith(tool.description), tool.name).toBe(true);
      expect(tool.description, tool.name).toMatch(/[.!?]$/);
    }
    for (const prompt of built.prompts) expect(prompt.description).toMatch(/[.!?]$/);
  });

  it('turns the prompt templates into MCPB prompt text with an account argument', () => {
    for (const [i, prompt] of built.prompts.entries()) {
      expect(PROMPTS[i]?.template).toContain(PROMPT_ACCOUNT_TOKEN);
      expect(prompt.arguments).toEqual(['account']);
      expect(prompt.text).toContain(MANIFEST_ACCOUNT_TOKEN);
      expect(prompt.text).not.toContain(PROMPT_ACCOUNT_TOKEN);
    }
  });

  it('leaves the template untouched', () => {
    const before = JSON.parse(templateText);
    const copy = structuredClone(before);
    buildManifest(copy, { version: '9.9.9', tools: TOOLS, prompts: PROMPTS });
    expect(copy).toEqual(before);
  });

  it('finds the first sentence without stopping at abbreviations', () => {
    expect(firstSentence('Describe a namespace by name (e.g. symbol.xym) or id. More.')).toBe(
      'Describe a namespace by name (e.g. symbol.xym) or id.',
    );
    expect(firstSentence('One thing, i.e. this one! Then more.')).toBe('One thing, i.e. this one!');
    expect(firstSentence('Spans\n  two lines. Rest.')).toBe('Spans two lines.');
    expect(firstSentence('No full stop at all')).toBe('No full stop at all');
    expect(firstSentence('Version 1.0.3.9 is fine. Next.')).toBe('Version 1.0.3.9 is fine.');
  });
});
