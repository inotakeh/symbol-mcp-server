/**
 * Guards the JSON Schema the server advertises in `tools/list` against constructs that some MCP
 * clients reject. Today that is a `type` array (`{"type":["string","null"]}`), which zod emits
 * for `.nullable()`; nullable fields must be `anyOf: [{...}, {type:'null'}]` instead. It also
 * rejects unconstrained sub-schemas (`{}` / `true` in additionalProperties, items or a union
 * branch), which the Inspector flags as "not constraining anything".
 *
 * Every registered tool (Phase 1 and later) is walked, so new tools are covered automatically.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/server.js';
import { startTestServer, type TestServer } from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

type JsonSchema = Record<string, unknown>;

/** Every schema node reachable from `root`, with a JSON-pointer-like path. */
function collect(root: unknown): Array<[string, JsonSchema]> {
  const out: Array<[string, JsonSchema]> = [];
  const stack: Array<[string, unknown]> = [['#', root]];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const [path, value] = item;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const node = value as JsonSchema;
    out.push([path, node]);
    for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
      const map = node[key];
      if (map && typeof map === 'object') {
        for (const [name, child] of Object.entries(map as Record<string, unknown>)) {
          stack.push([`${path}/${key}/${name}`, child]);
        }
      }
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      const list = node[key];
      if (Array.isArray(list)) {
        for (const [i, child] of list.entries()) stack.push([`${path}/${key}/${i}`, child]);
      }
    }
    for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
      if (node[key] && typeof node[key] === 'object') stack.push([`${path}/${key}`, node[key]]);
    }
  }
  return out;
}

describe('schema portability (tools/list)', () => {
  it('never advertises a `type` array in any inputSchema or outputSchema', async () => {
    server = await startTestServer();
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const [label, schema] of [
        ['inputSchema', tool.inputSchema],
        ['outputSchema', tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        for (const [path, node] of collect(schema)) {
          if (Array.isArray(node.type)) {
            offenders.push(`${tool.name} ${label} ${path}: type=${JSON.stringify(node.type)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never leaves additionalProperties, items or a union branch unconstrained ({} or true)', async () => {
    server = await startTestServer();
    const { tools } = await server.client.listTools();
    const isEmptySchema = (v: unknown) =>
      v === true || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const [label, schema] of [
        ['inputSchema', tool.inputSchema],
        ['outputSchema', tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        for (const [path, node] of collect(schema)) {
          for (const key of ['additionalProperties', 'items']) {
            if (key in node && isEmptySchema(node[key])) {
              offenders.push(`${tool.name} ${label} ${path}/${key} is an empty schema`);
            }
          }
          for (const key of ['anyOf', 'oneOf', 'allOf']) {
            const list = node[key];
            if (!Array.isArray(list)) continue;
            list.forEach((branch, i) => {
              if (isEmptySchema(branch)) {
                offenders.push(`${tool.name} ${label} ${path}/${key}/${i} is an empty schema`);
              }
            });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('serialises the Phase 1 nullable fields as anyOf with a null branch', async () => {
    server = await startTestServer();
    const { tools } = await server.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.outputSchema as JsonSchema]));
    const expectAnyOfNull = (tool: string, pointer: string) => {
      const schema = byName.get(tool);
      const node = collect(schema).find(([path]) => path === pointer)?.[1];
      expect(node, `${tool} ${pointer} exists`).toBeDefined();
      const anyOf = node?.anyOf as JsonSchema[] | undefined;
      expect(Array.isArray(anyOf), `${tool} ${pointer} uses anyOf`).toBe(true);
      expect(
        anyOf?.some((b) => b.type === 'null'),
        `${tool} ${pointer} has a null branch`,
      ).toBe(true);
      expect(node?.type, `${tool} ${pointer} has no top-level type`).toBeUndefined();
    };
    expectAnyOfNull('symbol_account_get', '#/properties/publicKey');
    expectAnyOfNull('symbol_account_get', '#/properties/mosaics/items/properties/alias');
    expectAnyOfNull('symbol_account_get', '#/properties/mosaics/items/properties/divisibility');
    expectAnyOfNull('symbol_account_get', '#/properties/supplementalPublicKeys/properties/linked');
    expectAnyOfNull('symbol_account_get', '#/properties/supplementalPublicKeys/properties/node');
    expectAnyOfNull('symbol_account_get', '#/properties/supplementalPublicKeys/properties/vrf');
    expectAnyOfNull('symbol_account_get', '#/properties/multisig');
    expectAnyOfNull('symbol_network_info', '#/properties/currency/properties/alias');
    expectAnyOfNull('symbol_node_status', '#/properties/node/properties/port');
    expectAnyOfNull('symbol_node_status', '#/properties/node/properties/nodePublicKey');
    expectAnyOfNull('symbol_voting_key_status', '#/properties/account/properties/publicKey');
  });
});
