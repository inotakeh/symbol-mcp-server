/**
 * In-process test harness (SDK-recommended): the MCP client talks to `createMcpHandler` through
 * a custom fetch, and the server's outbound `fetch` to the Symbol node is replaced by a fake
 * that serves fixtures and records every URL it was asked for.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { RestClient } from '../../src/client/rest.js';
import { type Config, loadConfig, resolveNetwork } from '../../src/config.js';
import { AppContext } from '../../src/context.js';
import { base32AddressToHex, publicKeyToAddress } from '../../src/domain/address.js';
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
/** Namespace name whose address alias is the fixture main account (see test/fixtures/README.md). */
export const ALIAS_NAMESPACE_NAME = 'fixture-alias';
export const ALIAS_NAMESPACE_ID = '935F70F34BFD4E33';

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

/**
 * A route's answer for a resource it does not have, as catapult-rest sends it (404 with
 * `no resource exists with id '<id>'`). Unstubbed paths answer "<path> does not exist" instead
 * (createFakeFetch), which the client reports as an error, so stub every expected miss with this.
 */
export function resourceNotFound(id: string): RouteHandler {
  return () =>
    jsonResponse({ code: 'ResourceNotFound', message: `no resource exists with id '${id}'` }, 404);
}

/** Synthetic value rule of test/fixtures/README.md: SHA3-256 of a label, upper-case hex. */
export const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();

export const XYM_MOSAIC_ID = '6BED913FA20223F8';
/** The main fixture account's XYM balance (account-voting.json) and its row in the holder list. */
export const FIXTURE_XYM_BALANCE = 4_321_000_000_000n;
export const FIXTURE_HOLDER_RANK = 157;
/** Balance step between neighbouring holders (1,000 XYM), so balances are strictly descending. */
export const HOLDER_BALANCE_STEP = 1_000_000_000n;
export const SYNTHETIC_HOLDER_COUNT = 300;

export interface HolderRow {
  readonly id: string;
  readonly account: Record<string, unknown> & { address: string; mosaics: MosaicEntry[] };
}
interface MosaicEntry {
  readonly id: string;
  readonly amount: string;
}

/**
 * `count` AccountInfoDTO rows ordered by descending balance of `mosaicId`. Row n has
 * FIXTURE_XYM_BALANCE + (157 - n) x HOLDER_BALANCE_STEP; row 157 is the main fixture account
 * itself, every other row is a synthetic holder with public key H("fixture:holder-NNN") and the
 * mainnet address derived from it (see test/fixtures/README.md).
 */
export function syntheticHolders(count: number, mosaicId = XYM_MOSAIC_ID): HolderRow[] {
  const main = fixture<{ account: { address: string; publicKey: string } }>(
    'mainnet/account-voting.json',
  ).account;
  const rows: HolderRow[] = [];
  for (let n = 1; n <= count; n++) {
    const amount = FIXTURE_XYM_BALANCE + BigInt(FIXTURE_HOLDER_RANK - n) * HOLDER_BALANCE_STEP;
    const label = String(n).padStart(3, '0');
    const isMain = n === FIXTURE_HOLDER_RANK;
    const publicKey = isMain ? main.publicKey : H(`fixture:holder-${label}`);
    const address = isMain ? main.address : base32AddressToHex(publicKeyToAddress(publicKey, 104));
    rows.push({
      id: H(`fixture:holder-doc-${label}`).slice(0, 24),
      account: {
        version: 1,
        address,
        addressHeight: '1',
        publicKey,
        publicKeyHeight: '1',
        accountType: isMain ? 1 : 0,
        supplementalPublicKeys: {},
        activityBuckets: [],
        mosaics: [{ id: mosaicId, amount: amount.toString() }],
        importance: '0',
        importanceHeight: '0',
      },
    });
  }
  return rows;
}

/**
 * Serves `rows` the way `GET /accounts?mosaicId=&orderBy=balance&order=desc` does: only rows
 * holding the requested mosaic, `pageSize` per page. Any other orderBy/order is a 409 like the
 * node's InvalidArgument, so a wrong query cannot pass by accident.
 */
export function accountSearchRoute(rows: readonly HolderRow[]): RouteHandler {
  return (_request, url) => {
    const q = url.searchParams;
    if (q.get('orderBy') !== 'balance' || q.get('order') !== 'desc' || !q.get('mosaicId')) {
      return jsonResponse({ code: 'InvalidArgument', message: 'unexpected query' }, 409);
    }
    const mosaicId = (q.get('mosaicId') ?? '').toUpperCase();
    const pageSize = Number(q.get('pageSize') ?? '10');
    const pageNumber = Number(q.get('pageNumber') ?? '1');
    const holders = rows.filter((r) =>
      r.account.mosaics.some((m) => m.id.toUpperCase() === mosaicId),
    );
    const data = holders.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    return jsonResponse({ data, pagination: { pageNumber, pageSize } });
  };
}

/** Default mainnet routes built from the captured fixtures. Keys are `METHOD /path`. */
export function mainnetRoutes(): Routes {
  return {
    'GET /node/info': fixture('mainnet/node-info.json'),
    'GET /node/health': fixture('mainnet/node-health.json'),
    'GET /node/peers': fixture('mainnet/peers.json'),
    // 0.3.0 fixtures (synthetic, see test/fixtures/README.md); node-time is TEST_NOW minus 1 s.
    'GET /node/storage': fixture('mainnet/node-storage.json'),
    'GET /node/time': fixture('mainnet/node-time.json'),
    'GET /node/server': fixture('mainnet/node-server.json'),
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
    // The main account is neither a multisig account nor a cosignatory.
    'GET /account/NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY/multisig': resourceNotFound(
      'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY',
    ),
    // Phase 2 fixtures (captured with scripts/capture-fixtures.mjs)
    [`GET /transactions/confirmed/${TRANSFER_HASH}`]: fixture('mainnet/transaction-transfer.json'),
    [`GET /transactions/confirmed/${AGGREGATE_HASH}`]: fixture(
      'mainnet/transaction-aggregate.json',
    ),
    'GET /transactions/confirmed': fixture('mainnet/transactions-search.json'),
    'GET /namespaces/E74B99BA41F4AFEE': fixture('mainnet/namespace-symbol-xym.json'),
    'GET /namespaces/A95F1F8A96159516': fixture('mainnet/namespace-symbol.json'),
    // Synthetic root namespace "fixture-alias" with an address alias to the main account.
    [`GET /namespaces/${ALIAS_NAMESPACE_ID}`]: fixture('mainnet/namespace-alias-account.json'),
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
    // 0.6.0: synthetic holder list for symbol_account_rank (300 rows, main account at rank 157).
    'GET /accounts': accountSearchRoute(syntheticHolders(SYNTHETIC_HOLDER_COUNT)),
    // Synthetic finalization proof for epoch 4010 (keys derived, see test/fixtures/README.md).
    'GET /finalization/proof/epoch/4010': fixture('mainnet/finalization-proof-epoch.json'),
    // No proof for the epoch before it: symbol_finality_participation reports it unavailable.
    'GET /finalization/proof/epoch/4009': resourceNotFound('4009'),
    // Shape of the real epoch 4027 proof: the prevote stage split into two message groups at one
    // height (2 and 15 signatures); the fixture account's key is in the larger group only.
    'GET /finalization/proof/epoch/4027': fixture('mainnet/finalization-proof-split-prevote.json'),
  };
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  /** Every URL the server asked for, in order. */
  readonly requests: URL[];
  /** The redirect mode of each of those requests, in the same order. */
  readonly redirects: Array<Request['redirect']>;
}

export function createFakeFetch(routes: Routes): FakeFetch {
  const requests: URL[] = [];
  const redirects: Array<Request['redirect']> = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    redirects.push(request.redirect);
    const key = `${request.method} ${url.pathname}`;
    let route = routes[key];
    if (route === undefined) {
      const wildcard = Object.keys(routes).find(
        (k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)),
      );
      if (wildcard !== undefined) route = routes[wildcard];
    }
    if (route === undefined) {
      // What catapult-rest (restify) answers for a path no route matches. A test that expects
      // "no such resource" must stub that exact path with resourceNotFound(), so a request to a
      // wrong path fails the test instead of passing as "not found".
      return jsonResponse(
        { code: 'ResourceNotFound', message: `${url.pathname} does not exist` },
        404,
      );
    }
    if (typeof route === 'function') {
      return (route as RouteHandler)(request, url);
    }
    return jsonResponse(route);
  }) as typeof fetch;
  return { fetch: fakeFetch, requests, redirects };
}

export interface TestServerOptions {
  readonly env?: Record<string, string>;
  readonly routes?: Routes;
  readonly now?: Date;
  /**
   * Protocol era of the test client. legacy (default): the 2025 `initialize` handshake, requested
   * explicitly because the SDK's `'auto'` mode negotiates the modern era against this in-process
   * handler. modern: pinned to 2026-07-28, so the connection goes through `server/discover` and
   * results carry the 2026 fields (`_meta`, `ttlMs` / `cacheScope` on lists).
   */
  readonly era?: 'legacy' | 'modern';
}

/**
 * One representative call per registered tool, in registration order, answered by the default
 * mainnet routes. server.test.ts (2025 era) and era_2026.test.ts (2026-07-28 era) both run it.
 */
export const SMOKE_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['symbol_network_info', {}],
  ['symbol_node_status', {}],
  ['symbol_account_get', { account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY' }],
  ['symbol_voting_key_status', { account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY' }],
  ['symbol_transaction_get', { transactionHash: TRANSFER_HASH }],
  ['symbol_transaction_search', { address: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY' }],
  ['symbol_mosaic_get', { mosaic: 'symbol.xym' }],
  ['symbol_namespace_get', { namespace: 'symbol.xym' }],
  ['symbol_fee_estimate', {}],
  ['symbol_address_parse', { value: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY' }],
  ['symbol_time_convert', { height: 5_763_675 }],
  ['symbol_harvesting_status', { account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY' }],
  ['symbol_network_compare', {}],
  [
    'symbol_harvesting_income',
    {
      account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY',
      fromHeight: 5_763_675,
      toHeight: 5_763_675,
    },
  ],
  ['symbol_transaction_status', { transactionHashes: [TRANSFER_HASH] }],
  [
    'symbol_finality_participation',
    { account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY', epoch: 4010, epochs: 2 },
  ],
  ['symbol_delegation_diagnose', { account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY' }],
  ['symbol_node_health', {}],
  ['symbol_version_drift', {}],
  // No SYMBOL_STATE_DIR in the default harness, so the smoke call never touches the disk.
  ['symbol_harvester_watch', { mode: 'compare' }],
  ['symbol_account_rank', { top: 5 }],
  [
    'symbol_holdings_value',
    { account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY', unitPrice: '1', currency: 'JPY' },
  ],
];

/**
 * Extra smoke calls that do not map 1:1 to a tool (SMOKE_CALLS must): the same tools with the
 * account given as a namespace name, resolved through the fixture namespace.
 */
export const EXTRA_SMOKE_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['symbol_account_get', { account: ALIAS_NAMESPACE_NAME }],
  ['symbol_address_parse', { value: ALIAS_NAMESPACE_NAME }],
];

/** One HTTP response of the MCP handler, as the client received it (body read lazily). */
export interface RawResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Promise<string>;
}

export interface TestServer {
  readonly client: Client;
  readonly requests: URL[];
  /** The redirect mode of every node-side request, in the order of `requests`. */
  readonly redirects: Array<Request['redirect']>;
  /** Every MCP-side HTTP response, in order (the node-side fetch is `requests`). */
  readonly rawResponses: RawResponse[];
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

export interface TestContext {
  readonly ctx: AppContext;
  readonly config: Config;
  /** Every URL asked of the (fake) node, in order. */
  readonly requests: URL[];
  /** The redirect mode of each of those requests, in the same order. */
  readonly redirects: Array<Request['redirect']>;
}

/**
 * Stubs the global fetch with the routes and builds the AppContext the way index.ts does
 * (config -> RestClient -> resolveNetwork). For code that runs outside MCP, such as the CLI
 * check; the caller undoes the stub with `vi.unstubAllGlobals()`.
 */
export async function createTestContext(options: TestServerOptions = {}): Promise<TestContext> {
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
  return { ctx, config, requests: fake.requests, redirects: fake.redirects };
}

/**
 * Boots the server the same way index.ts does (config -> RestClient -> resolveNetwork ->
 * createServer) but in-process, with fetch stubbed.
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const { ctx, config, requests, redirects } = await createTestContext(options);

  const handler = createMcpHandler(() => createServer(ctx));
  const rawResponses: RawResponse[] = [];
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.local/mcp'), {
    fetch: async (url, init) => {
      const response = await handler.fetch(new Request(url, init));
      rawResponses.push({
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: response.clone().text(),
      });
      return response;
    },
  });
  const client = new Client(
    { name: 'symbol-mcp-server-tests', version: '0.0.0' },
    {
      versionNegotiation: {
        mode: options.era === 'modern' ? { pin: '2026-07-28' } : 'legacy',
      },
    },
  );
  await client.connect(transport);

  return {
    client,
    requests,
    redirects,
    rawResponses,
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
