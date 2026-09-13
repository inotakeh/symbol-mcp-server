/**
 * The same server on the 2026-07-28 protocol era. The SDK client is pinned to that revision, so
 * the connection goes through `server/discover` instead of `initialize`, every result carries the
 * server identity in `_meta`, and the cacheable lists carry `ttlMs` / `cacheScope` (the hints
 * declared in src/server.ts). The 2025-era tests (server.test.ts and the per-tool files) stay as
 * they are; this file is the regression test for the other era, over the same in-process
 * `createMcpHandler.fetch` path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../../src/instructions.js';
import { LIST_CACHE_TTL_MS, PROMPTS, SERVER_NAME, TOOLS } from '../../src/server.js';
import { TOOL_ANNOTATIONS } from '../../src/tools/_shared.js';
import {
  EXTRA_SMOKE_CALLS,
  SMOKE_CALLS,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ACCOUNT = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
type Loose = Record<string, unknown>;

/** JSON-RPC results of the raw MCP responses, oldest first (2026-era responses are plain JSON). */
async function rawResults(s: TestServer): Promise<Loose[]> {
  const out: Loose[] = [];
  for (const r of s.rawResponses) {
    if (r.contentType?.startsWith('application/json') !== true) continue;
    const parsed = JSON.parse(await r.body) as { result?: Loose };
    if (parsed.result) out.push(parsed.result);
  }
  return out;
}

describe('2026-07-28 protocol era', () => {
  it('negotiates the modern era through server/discover and exposes instructions and identity', async () => {
    server = await startTestServer({ era: 'modern' });
    expect(server.client.getProtocolEra()).toBe('modern');
    expect(server.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(server.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(server.client.getDiscoverResult()?.instructions).toBe(SERVER_INSTRUCTIONS);
    // On this era the identity travels in the result _meta, not in an initialize result.
    expect(server.client.getServerVersion()).toEqual({ name: SERVER_NAME, version: '0.0.0-test' });

    const results = await rawResults(server);
    const discover = results.find((r) => Array.isArray(r.supportedVersions));
    expect(discover).toBeDefined();
    expect(discover?.supportedVersions).toContain('2026-07-28');
    expect(discover?.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(discover?._meta).toMatchObject({
      [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: '0.0.0-test' },
    });
    expect(server.rawResponses.every((r) => r.contentType?.startsWith('application/json'))).toBe(
      true,
    );
  });

  it('lists the tools in registration order with annotations, outputSchema and the cache hint', async () => {
    server = await startTestServer({ era: 'modern' });
    const result = (await server.client.listTools()) as Loose & {
      tools: Array<{
        name: string;
        title?: string;
        annotations?: Loose;
        outputSchema?: { properties?: Loose };
      }>;
    };
    expect(result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(result.tools).toHaveLength(17);
    for (const tool of result.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toMatchObject(TOOL_ANNOTATIONS);
      expect(Object.keys(tool.outputSchema?.properties ?? {})[0]).toBe('summary');
    }
    expect(result.ttlMs).toBe(LIST_CACHE_TTL_MS);
    expect(result.cacheScope).toBe('public');
    expect((result._meta as Loose)[SERVER_INFO_META_KEY]).toEqual({
      name: SERVER_NAME,
      version: '0.0.0-test',
    });
    // The same fields on the wire, not only on the decoded object.
    const raw = (await rawResults(server)).find((r) => Array.isArray(r.tools));
    expect(raw).toMatchObject({ ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'public' });
    expect(raw?.tools).toHaveLength(17);
  });

  it('lists and renders the prompts, with the cache hint on the list only', async () => {
    server = await startTestServer({ era: 'modern' });
    const list = (await server.client.listPrompts()) as Loose & {
      prompts: Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }>;
    };
    expect(list.prompts.map((p) => p.name)).toEqual(PROMPTS.map((p) => p.name));
    expect(list.prompts).toHaveLength(2);
    for (const prompt of list.prompts) {
      expect(prompt.arguments?.map((a) => [a.name, a.required])).toEqual([['account', true]]);
    }
    expect(list.ttlMs).toBe(LIST_CACHE_TTL_MS);
    expect(list.cacheScope).toBe('public');

    const rendered = (await server.client.getPrompt({
      name: 'voting_key_renewal_checklist',
      arguments: { account: ACCOUNT },
    })) as Loose & { messages: Array<{ role: string; content: { type: string; text?: string } }> };
    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0]?.role).toBe('user');
    expect(rendered.messages[0]?.content.type).toBe('text');
    expect(rendered.messages[0]?.content.text).toContain(`account "${ACCOUNT}"`);
    expect(rendered.ttlMs).toBeUndefined();
    expect(rendered.cacheScope).toBeUndefined();
    const rawPrompts = (await rawResults(server)).find((r) => Array.isArray(r.prompts));
    expect(rawPrompts).toMatchObject({ ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'public' });
  });

  it('answers tool calls with both a text block and structuredContent', async () => {
    server = await startTestServer({ era: 'modern' });
    const before = server.requests.length;

    // Offline tool: no request to the node.
    const parsed = (await server.client.callTool({
      name: 'symbol_address_parse',
      arguments: { value: ACCOUNT },
    })) as Loose & { content: Array<{ type: string; text?: string }>; structuredContent?: Loose };
    expect(parsed.isError).not.toBe(true);
    expect(parsed.content).toHaveLength(1);
    expect(parsed.content[0]?.type).toBe('text');
    expect(JSON.parse(parsed.content[0]?.text ?? '')).toEqual(parsed.structuredContent);
    expect(parsed.structuredContent?.valid).toBe(true);
    expect(Object.keys(parsed.structuredContent ?? {})[0]).toBe('summary');
    expect(server.requests.length).toBe(before);

    // Node-backed tool: the stubbed node answers, only the configured host is contacted.
    const info = (await server.client.callTool({ name: 'symbol_network_info' })) as Loose & {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Loose;
    };
    expect(info.isError).not.toBe(true);
    expect(info.content[0]?.type).toBe('text');
    expect(JSON.parse(info.content[0]?.text ?? '')).toEqual(info.structuredContent);
    expect(info.structuredContent?.network).toMatchObject({ name: 'mainnet', identifier: 104 });
    expect(server.requests.length).toBeGreaterThan(before);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));

    // Tool results are not cacheable: no cache fields, whatever the hints for the lists say.
    expect(info.ttlMs).toBeUndefined();
    expect(info.cacheScope).toBeUndefined();
    expect((info._meta as Loose)[SERVER_INFO_META_KEY]).toEqual({
      name: SERVER_NAME,
      version: '0.0.0-test',
    });
  });

  describe('every tool answers on this era with text, structuredContent and a valid schema', () => {
    for (const [name, args] of [...SMOKE_CALLS, ...EXTRA_SMOKE_CALLS]) {
      it(`${name} ${JSON.stringify(args)}`, async () => {
        server = await startTestServer({ era: 'modern' });
        const result = (await server.client.callTool({ name, arguments: args })) as Loose & {
          content: Array<{ type: string; text?: string }>;
          structuredContent?: Loose;
        };
        expect(result.isError).not.toBe(true);
        expect(result.content[0]?.type).toBe('text');
        expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
        expect(Object.keys(result.structuredContent ?? {})[0]).toBe('summary');
        const def = TOOLS.find((t) => t.name === name);
        expect(def?.outputSchema.safeParse(result.structuredContent).success).toBe(true);
        expect(result._meta).toMatchObject({
          [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: '0.0.0-test' },
        });
        expect(result.ttlMs).toBeUndefined();
      });
    }
  });

  it('carries a CSV text block when symbol_harvesting_income is asked for csv', async () => {
    server = await startTestServer({ era: 'modern' });
    const result = (await server.client.callTool({
      name: 'symbol_harvesting_income',
      arguments: { account: ACCOUNT, fromHeight: 5_763_675, toHeight: 5_763_675, output: 'csv' },
    })) as Loose & { content: Array<{ type: string; text?: string }>; structuredContent?: Loose };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text?.startsWith('period,receipts,xym,raw,')).toBe(true);
    expect(result.structuredContent?.csv).toBe(result.content[0]?.text);
    expect(Object.keys(result.structuredContent ?? {})[0]).toBe('summary');
  });
});
