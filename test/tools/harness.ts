/**
 * In-process test harness (SDK-recommended): the MCP client talks to `createMcpHandler` through
 * a custom fetch, and the server's outbound `fetch` to the Symbol node is replaced by a fake
 * that serves fixtures and records every URL it was asked for.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { RestClient } from '../../src/client/rest.js';
import { type Config, loadConfig, resolveNetwork } from '../../src/config.js';
import { AppContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture<T = unknown>(relativePath: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, relativePath), 'utf8')) as T;
}

export const TEST_NODE_URL = 'https://node.test:3001';
export const TEST_NODE_HOST = 'node.test:3001';
/**
 * Fixed "now" for deterministic date estimates. The fixture block 5763675 has network timestamp
 * 173156113808 ms = 2026-09-10T03:01:38.808Z (epochAdjustment 1615853185s); NOW is ~3 min later.
 */
export const TEST_NOW = new Date('2026-09-10T03:05:00.000Z');
export const FIXTURE_BLOCK_TIME = new Date('2026-09-10T03:01:38.808Z');
/** Hashes of the captured transaction fixtures. */
export const TRANSFER_HASH = 'FAEEB0420BF639D4ACB6C2934BF22C3F5AB71DED20D4EAB986CF2C18B914C12F';
export const AGGREGATE_HASH = '1B39E0DDA84039ECBB33F14E1937C68493E4076366D5DDD68F63D8AD4D19D402';
/** Synthetic hashes of transaction-status.json (H("fixture:status-hash-<group>")). */
export const STATUS_HASH_UNCONFIRMED =
  '7E0AF903994D1DFFB48C89067DE94C46C588D86BCA8D5B089AEB1ACC56EB2B50';
export const STATUS_HASH_PARTIAL =
  'D257B95DB7EE6F34F63BE235EC8B13197280305F2C8BD02C52C0E3C58C7E9F7B';
export const STATUS_HASH_FAILED =
  '9539AD0F4441E381D08B69C63245364C385F5F09553AAF8A2E613AF476B6DBCB';

export type RouteHandler = (request: Request, url: URL) => Response | Promise<Response>;
/**
 * Keys are `METHOD /path`. A key ending in `*` (`GET /blocks/*`) matches every path with that
 * prefix and is consulted only when no exact key matches.
 */
export type Routes = Record<string, unknown | RouteHandler>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Default mainnet routes built from the captured fixtures. Keys are `METHOD /path`. */
export function mainnetRoutes(): Routes {
  return {
    'GET /node/info': fixture('mainnet/node-info.json'),
    'GET /node/health': fixture('mainnet/node-health.json'),
    'GET /node/peers': fixture('mainnet/peers.json'),
    'GET /chain/info': fixture('mainnet/chain-info.json'),
    'GET /network/properties': fixture('mainnet/network-properties.json'),
    'GET /network/fees/transaction': fixture('mainnet/fees.json'),
    'GET /blocks/5763675': fixture('mainnet/block-5763675.json'),
    'GET /blocks/5753675': fixture('mainnet/block-5753675.json'),
    'GET /mosaics/6BED913FA20223F8': fixture('mainnet/mosaic-xym.json'),
    'GET /mosaics/66BAE04E8758599E': fixture('mainnet/mosaic-other.json'),
    // Batch lookup: only the mosaics that exist are returned (order not guaranteed).
    'POST /mosaics': async (request: Request) => {
      const body = (await request.json()) as { mosaicIds?: string[] };
      const known: Record<string, unknown> = {
        '6BED913FA20223F8': fixture('mainnet/mosaic-xym.json'),
        '66BAE04E8758599E': fixture('mainnet/mosaic-other.json'),
      };
      const ids = (body.mosaicIds ?? []).map((id) => id.toUpperCase());
      return jsonResponse(ids.filter((id) => id in known).map((id) => known[id]));
    },
    'POST /namespaces/mosaic/names': fixture('mainnet/mosaic-names.json'),
    'GET /accounts/NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY': fixture('mainnet/account-voting.json'),
    'GET /accounts/CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E': fixture(
      'mainnet/account-voting.json',
    ),
    // Phase 2 fixtures (captured with scripts/capture-fixtures.mjs)
    [`GET /transactions/confirmed/${TRANSFER_HASH}`]: fixture('mainnet/transaction-transfer.json'),
    [`GET /transactions/confirmed/${AGGREGATE_HASH}`]: fixture(
      'mainnet/transaction-aggregate.json',
    ),
    'GET /transactions/confirmed': fixture('mainnet/transactions-search.json'),
    'GET /namespaces/E74B99BA41F4AFEE': fixture('mainnet/namespace-symbol-xym.json'),
    'GET /namespaces/A95F1F8A96159516': fixture('mainnet/namespace-symbol.json'),
    'POST /namespaces/names': fixture('mainnet/namespace-names.json'),
    'GET /node/unlockedaccount': fixture('mainnet/unlockedaccount.json'),
    // 0.2.0 fixtures (harvest receipts; identifiers synthetic, see test/fixtures/README.md)
    'GET /blocks/5764879': fixture('mainnet/block-5764879.json'),
    'GET /statements/transaction': fixture('mainnet/statement-harvest-one-block.json'),
    // 0.3.0 fixtures: statuses of four hashes; hashes the node does not track are left out.
    'POST /transactionStatus': async (request: Request) => {
      const body = (await request.json()) as { hashes?: string[] };
      const wanted = new Set((body.hashes ?? []).map((h) => h.toUpperCase()));
      const known = fixture<Array<{ hash: string }>>('mainnet/transaction-status.json');
      return jsonResponse(known.filter((s) => wanted.has(s.hash.toUpperCase())));
    },
  };
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  /** Every URL the server asked for, in order. */
  readonly requests: URL[];
}

export function createFakeFetch(routes: Routes): FakeFetch {
  const requests: URL[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    const key = `${request.method} ${url.pathname}`;
    let route = routes[key];
    if (route === undefined) {
      const wildcard = Object.keys(routes).find(
        (k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)),
      );
      if (wildcard !== undefined) route = routes[wildcard];
    }
    if (route === undefined) {
      return jsonResponse(fixture('mainnet/not-found.json'), 404);
    }
    if (typeof route === 'function') {
      return (route as RouteHandler)(request, url);
    }
    return jsonResponse(route);
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}

export interface TestServerOptions {
  readonly env?: Record<string, string>;
  readonly routes?: Routes;
  readonly now?: Date;
}

export interface TestServer {
  readonly client: Client;
  readonly requests: URL[];
  readonly config: Config;
  readonly ctx: AppContext;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface ToolCallResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structuredContent: Record<string, unknown> | undefined;
}

/**
 * Boots the server the same way index.ts does (config -> RestClient -> resolveNetwork ->
 * createServer) but in-process, with fetch stubbed.
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const fake = createFakeFetch(options.routes ?? mainnetRoutes());
  vi.stubGlobal('fetch', fake.fetch);

  const config = loadConfig({ SYMBOL_NODE_URL: TEST_NODE_URL, ...options.env });
  const rest = new RestClient({
    baseUrl: config.nodeUrl,
    timeoutMs: config.requestTimeoutMs,
    userAgent: 'symbol-mcp-server/test',
  });
  const network = await resolveNetwork(rest, config);
  const now = options.now ?? TEST_NOW;
  const ctx = new AppContext(config, rest, network, '0.0.0-test', () => now);

  const handler = createMcpHandler(() => createServer(ctx));
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'symbol-mcp-server-tests', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);

  return {
    client,
    requests: fake.requests,
    config,
    ctx,
    async callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return {
        isError: result.isError === true,
        text,
        structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      };
    },
    async close() {
      await client.close();
      await handler.close();
      vi.unstubAllGlobals();
    },
  };
}
