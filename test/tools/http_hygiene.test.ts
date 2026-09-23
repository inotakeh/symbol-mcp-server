/**
 * HTTP hygiene as the tools and the check CLI see it: a node that answers with a redirect gets an
 * error with a hint and is never followed, and no tool argument reaches a request path or query as
 * raw text (src/client/rest.ts SAFE_REQUEST_PATH).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../../src/cli/check.js';
import { type CliDeps, runCli, serverStartupFailureText } from '../../src/cli.js';
import { RestError, SAFE_REQUEST_PATH } from '../../src/client/rest.js';
import { REDIRECT_ADVICE } from '../../src/config.js';
import {
  createFakeFetch,
  createTestContext,
  fixture,
  jsonResponse,
  mainnetRoutes,
  startTestServer,
  TEST_NODE_HOST,
  TEST_NOW,
  type TestServer,
} from './harness.js';

const ACCOUNT = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
/** Where the hostile node would like the client to go. */
const ELSEWHERE = 'https://elsewhere.example/node';

function redirectTo(status: number) {
  return () => new Response(null, { status, headers: { location: ELSEWHERE } });
}

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
});

describe('a node that answers with a redirect', () => {
  it('is an error with a hint; the Location is neither followed nor quoted', async () => {
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /chain/info': redirectTo(301) },
    });
    const result = await server.callTool('symbol_network_info');
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Node ${TEST_NODE_HOST} answered /chain/info with a redirect (HTTP 301), which this server never follows. ${REDIRECT_ADVICE}`,
    );
    expect(result.text).not.toMatch(/elsewhere/);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('is reported for that reference node by symbol_network_compare, not followed', async () => {
    const chain = fixture('mainnet/chain-info.json');
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: 'https://reference-a.test:3001' },
      routes: {
        ...mainnetRoutes(),
        'GET /chain/info': (_request: Request, url: URL) =>
          url.host === 'reference-a.test:3001' ? redirectTo(307)() : jsonResponse(chain),
      },
    });
    const result = await server.callTool('symbol_network_compare');
    expect(result.isError).toBe(false);
    const nodes = result.structuredContent?.nodes as Array<Record<string, unknown>>;
    expect(nodes[1]).toMatchObject({
      host: 'reference-a.test:3001',
      reachable: false,
      error:
        'redirect: reference-a.test:3001 answered /chain/info with a redirect (HTTP 307), which is not followed',
    });
    expect(result.text).not.toMatch(/elsewhere/);
    expect(server.requests.map((u) => u.host)).not.toContain('elsewhere.example');
  });

  it('is named as a redirect, not as unreachable, by symbol_version_drift', async () => {
    const info = fixture('mainnet/node-info.json');
    server = await startTestServer({
      env: { SYMBOL_REFERENCE_NODES: 'https://reference-a.test:3001' },
      routes: {
        ...mainnetRoutes(),
        'GET /node/info': (_request: Request, url: URL) =>
          url.host === 'reference-a.test:3001' ? redirectTo(302)() : jsonResponse(info),
      },
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.isError).toBe(false);
    const notes = result.structuredContent?.notes as string[];
    expect(notes).toContain(
      '1 reference node(s) answered with a redirect, which is never followed; set their SYMBOL_REFERENCE_NODES entries to the REST API URLs themselves.',
    );
    expect(notes.join('\n')).not.toMatch(/could not be reached/);
    expect(result.structuredContent?.sample).toMatchObject({ referenceNodes: 0 });
  });

  it('names the fix when the MCP server cannot start', () => {
    const redirect = new RestError(
      'redirect',
      'node.test:3001 answered /node/info with a redirect (HTTP 301), which is not followed',
      '/node/info',
      301,
    );
    expect(serverStartupFailureText(redirect)).toBe(`${redirect.message}. ${REDIRECT_ADVICE}`);
    const down = new RestError('unreachable', 'could not reach node.test:3001', '/node/info');
    expect(serverStartupFailureText(down)).toBe('could not reach node.test:3001');
  });

  it('stops the check CLI at start-up with exit code 3 and the redirect advice', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({ ...mainnetRoutes(), 'GET /node/info': redirectTo(308) }).fetch,
    );
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      env: { SYMBOL_NODE_URL: 'https://node.test:3001' },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      serve: vi.fn(async () => {}),
      version: '0.0.0-test',
      now: () => TEST_NOW,
    };
    expect(await runCli(['check'], deps)).toBe(3);
    expect(out).toEqual([]);
    const printed = err.join('\n');
    expect(printed).toMatch(/could not read \/node\/info from node\.test:3001 \(redirect 308\)/);
    expect(printed).toContain(REDIRECT_ADVICE);
    expect(printed).not.toMatch(/elsewhere/);
  });

  it('makes the check exit with 3 when the node redirects everything after start-up', async () => {
    // /node/info answers once, for the start-up; from then on every request is redirected.
    let infoServed = false;
    const info = fixture('mainnet/node-info.json');
    const { ctx } = await createTestContext({
      routes: {
        'GET /node/info': () => {
          if (infoServed) return redirectTo(301)();
          infoServed = true;
          return jsonResponse(info);
        },
        'GET /*': redirectTo(301),
        'POST /*': redirectTo(301),
      },
    });
    const diagnostics: string[] = [];
    const report = await runCheck(ctx, {
      account: null,
      warnDays: 14,
      onDiagnostic: (line) => diagnostics.push(line),
    });
    expect(report).toMatchObject({ verdict: 'error', exitCode: 3 });
    expect(diagnostics.join('\n')).toMatch(/answers only with redirects/);
  });
});

describe('tool arguments never reach a request path or query as raw text', () => {
  const RAW = [
    '../../node/info',
    `${ACCOUNT}?x=1`,
    `${ACCOUNT}#fragment`,
    '%2e%2e%2fnode%2finfo',
    'symbol.xym/../../node',
    'alice bob',
    '6BED913FA20223F8/../../node/info',
    'a\\b',
  ];
  const CALLS: ReadonlyArray<readonly [string, (raw: string) => Record<string, unknown>]> = [
    ['symbol_account_get', (raw) => ({ account: raw })],
    ['symbol_voting_key_status', (raw) => ({ account: raw })],
    ['symbol_harvesting_status', (raw) => ({ account: raw })],
    ['symbol_harvesting_income', (raw) => ({ account: raw, fromHeight: 1, toHeight: 2 })],
    ['symbol_finality_participation', (raw) => ({ account: raw })],
    ['symbol_delegation_diagnose', (raw) => ({ account: raw })],
    ['symbol_account_rank', (raw) => ({ account: raw })],
    ['symbol_account_rank', (raw) => ({ mosaic: raw })],
    ['symbol_holdings_value', (raw) => ({ account: raw, unitPrice: '1', currency: 'JPY' })],
    [
      'symbol_holdings_value',
      (raw) => ({ account: ACCOUNT, unitPrice: '1', currency: 'JPY', mosaic: raw }),
    ],
    ['symbol_transaction_search', (raw) => ({ address: raw })],
    ['symbol_transaction_search', (raw) => ({ address: ACCOUNT, type: raw })],
    ['symbol_transaction_get', (raw) => ({ transactionHash: raw })],
    ['symbol_transaction_status', (raw) => ({ transactionHashes: [raw] })],
    ['symbol_mosaic_get', (raw) => ({ mosaic: raw })],
    ['symbol_namespace_get', (raw) => ({ namespace: raw })],
    ['symbol_address_parse', (raw) => ({ value: raw })],
  ];

  it('treats each malformed identifier as bad input and sends only plain paths', async () => {
    server = await startTestServer();
    for (const [name, args] of CALLS) {
      for (const raw of RAW) {
        const label = `${name} ${JSON.stringify(args(raw))}`;
        const before = server.requests.length;
        const result = await server.callTool(name, args(raw));
        // A validation error with a hint, never the internal error a refused path would cause.
        expect(result.text, label).not.toMatch(/Unexpected internal error/);
        for (const url of server.requests.slice(before)) {
          expect(`${url.pathname}${url.search}`, label).toMatch(SAFE_REQUEST_PATH);
        }
      }
    }
  });
});
