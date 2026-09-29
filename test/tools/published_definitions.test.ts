/**
 * Snapshot of the definitions every client receives: the `tools/list` and `prompts/list` results
 * and the server instructions, as they travel on the wire. Object keys are sorted (arrays keep
 * their order, so the registration order stays part of the snapshot), and nothing else goes in:
 * no server version, no 2026-era cache hints or `_meta`. The file therefore changes only when a
 * definition does, which makes a definition change visible in review and lets a patch release
 * show that it changed none.
 */
import { describe, expect, it } from 'vitest';
import { startTestServer } from './harness.js';

const SNAPSHOT_FILE = 'test/tools/__snapshots__/published-definitions.json';

const MISMATCH_MESSAGE = [
  `The published tool or prompt definitions or the server instructions no longer match ${SNAPSHOT_FILE}.`,
  'If the change is intended, update the file with',
  '`npm test -- test/tools/published_definitions.test.ts --update` and commit it with the change.',
  'A change to descriptive text only (the instructions; the description and title of tools,',
  'prompts and prompt arguments; the title in annotations; the description and title keywords of',
  'the schemas) can ship in a patch, with no restart note. Anything else is a change to the shape',
  '(a tool, prompt or prompt argument added, removed or reordered; an input or output field added',
  'or removed; a type, what is required (as a set), an enum, a default, a bound, a const or the',
  'annotations changed) and needs a minor version whose',
  'CHANGELOG.md section starts with "> **After upgrading, restart your MCP host (Claude Desktop,',
  'Claude Code and others).**", because clients check results against the tools/list they cached.',
  'scripts/release-check.mjs applies this rule at release time (DESIGN-BRIEF §5)',
].join(' ');

type Loose = Record<string, unknown>;

/** Deep copy with the keys of every object in code-point order; arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const object = value as Loose;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    );
  }
  return value;
}

/** JSON-RPC messages in one MCP HTTP response body: plain JSON or server-sent events. */
function messagesOf(contentType: string | null, body: string): Loose[] {
  if (contentType?.startsWith('text/event-stream') === true) {
    return body
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart())
          .join('\n'),
      )
      .filter((data) => data !== '')
      .map((data) => JSON.parse(data) as Loose);
  }
  return body.trim() === '' ? [] : [JSON.parse(body) as Loose];
}

/**
 * Connects a client on the given protocol era, lists the tools and the prompts, and returns the
 * definitions exactly as the server sent them (read from the raw responses, not from the decoded
 * client objects), with sorted keys.
 */
async function publishedDefinitions(era: 'legacy' | 'modern'): Promise<unknown> {
  const server = await startTestServer({ era });
  try {
    await server.client.listTools();
    await server.client.listPrompts();
    const results: Loose[] = [];
    for (const response of server.rawResponses) {
      for (const message of messagesOf(response.contentType, await response.body)) {
        if (message.result !== undefined) results.push(message.result as Loose);
      }
    }
    const tools = results.find((r) => Array.isArray(r.tools));
    const prompts = results.find((r) => Array.isArray(r.prompts));
    const instructions = results.find((r) => typeof r.instructions === 'string')?.instructions;
    // One page each: a cursor would mean the lists above are incomplete.
    expect(tools?.nextCursor).toBeUndefined();
    expect(prompts?.nextCursor).toBeUndefined();
    expect(typeof instructions).toBe('string');
    return sortKeys({ instructions, prompts: prompts?.prompts, tools: tools?.tools });
  } finally {
    await server.close();
  }
}

describe('published definitions', () => {
  it('match the committed snapshot', async () => {
    const definitions = await publishedDefinitions('legacy');
    // The path is relative to this file.
    await expect(`${JSON.stringify(definitions, null, 2)}\n`, MISMATCH_MESSAGE).toMatchFileSnapshot(
      './__snapshots__/published-definitions.json',
    );
  });

  it('are the same on the 2026-07-28 era', async () => {
    const legacy = await publishedDefinitions('legacy');
    expect(await publishedDefinitions('modern')).toEqual(legacy);
  });
});
