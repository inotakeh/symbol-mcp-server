/**
 * invisibleCharactersRemoved (DESIGN-BRIEF §2-8): which tools carry it, where it sits in the
 * published output schema, 0 for clean data, and exact counts per source, each source counted
 * once per call. Special characters are built from code points: this file contains none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../../src/server.js';
import { removedCharactersLine } from '../../src/tools/_shared.js';
import {
  fixture,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  SMOKE_CALLS,
  startTestServer,
  type TestServer,
  TRANSFER_HASH,
} from './harness.js';

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const ZWSP = cp(0x200b);
const ESC = cp(0x1b);
const CSI = cp(0x9b);
const LF = cp(0x0a);

/** The tools whose output shows text written by others (DESIGN-BRIEF §2-8). */
const TOOLS_WITH_UNTRUSTED_TEXT = [
  'symbol_network_info',
  'symbol_node_status',
  'symbol_account_get',
  'symbol_voting_key_status',
  'symbol_transaction_get',
  'symbol_transaction_search',
  'symbol_mosaic_get',
  'symbol_namespace_get',
  'symbol_fee_estimate',
  'symbol_harvesting_status',
  'symbol_harvesting_income',
  'symbol_transaction_status',
  'symbol_delegation_diagnose',
  'symbol_node_health',
  'symbol_version_drift',
  'symbol_account_rank',
  'symbol_holdings_value',
];

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
});

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

/** mainnetRoutes with the currency mosaic's alias name replaced. */
function currencyAliasRoute(name: string): Routes {
  return {
    'POST /namespaces/mosaic/names': {
      mosaicNames: [
        { mosaicId: '6BED913FA20223F8', names: [name] },
        { mosaicId: '66BAE04E8758599E', names: [] },
      ],
    },
  };
}

function lastSummaryLine(structured: Record<string, unknown> | undefined): string | undefined {
  return String(structured?.summary ?? '')
    .split('\n')
    .at(-1);
}

describe('which tools report invisibleCharactersRemoved', () => {
  it('is exactly the tools that show text written by others', () => {
    const flagged = TOOLS.filter((t) => t.untrustedText === true).map((t) => t.name);
    expect(flagged.sort()).toEqual([...TOOLS_WITH_UNTRUSTED_TEXT].sort());
  });

  it('is the last, required property of their published output schemas, and of no other', async () => {
    server = await startTestServer();
    const { tools } = await server.client.listTools();
    for (const tool of tools) {
      const schema = tool.outputSchema as { properties?: object; required?: string[] };
      const properties = Object.keys(schema.properties ?? {});
      if (TOOLS_WITH_UNTRUSTED_TEXT.includes(tool.name)) {
        expect(properties.at(-1), tool.name).toBe('invisibleCharactersRemoved');
        expect(schema.required, tool.name).toContain('invisibleCharactersRemoved');
      } else {
        expect(properties, tool.name).not.toContain('invisibleCharactersRemoved');
      }
    }
  });
});

describe('with clean data', () => {
  for (const [name, args] of SMOKE_CALLS.filter(([n]) => TOOLS_WITH_UNTRUSTED_TEXT.includes(n))) {
    it(`${name} reports 0 and adds no summary line`, async () => {
      server = await startTestServer();
      const result = await server.callTool(name, args);
      expect(result.isError, result.text).toBe(false);
      expect(result.structuredContent?.invisibleCharactersRemoved).toBe(0);
      expect(String(result.structuredContent?.summary)).not.toMatch(/invisible character/);
    });
  }
});

describe('exact counts, each source once per call', () => {
  it('symbol_node_status counts friendlyName, host and the statuses, and says so last', async () => {
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    server = await startTestServer({
      routes: routes({
        'GET /node/info': {
          ...info,
          friendlyName: `fix${ZWSP}ture${LF}node`,
          host: `h${ESC}${CSI}`,
        },
        'GET /node/health': { status: { apiNode: `up${ZWSP}`, db: 'up' } },
      }),
    });
    const result = await server.callTool('symbol_node_status');
    // friendlyName 1 (the line break becomes a space, not counted), host 2, apiNode 1.
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(4);
    expect(lastSummaryLine(result.structuredContent)).toBe(removedCharactersLine(4));
    expect(result.structuredContent?.node).toMatchObject({ friendlyName: 'fixture node' });
  });

  it('symbol_version_drift counts the REST version; the verdict line stays first', async () => {
    const server_ = fixture<{ serverInfo: Record<string, unknown> }>('mainnet/node-server.json');
    server = await startTestServer({
      routes: routes({
        'GET /node/server': {
          serverInfo: { ...server_.serverInfo, restVersion: `2.4.4${ZWSP}${ZWSP}` },
        },
      }),
    });
    const result = await server.callTool('symbol_version_drift');
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(2);
    const lines = String(result.structuredContent?.summary).split('\n');
    expect(lines[0]).toMatch(/^version drift: /);
    expect(lines.at(-1)).toBe(removedCharactersLine(2));
    expect(lines.at(-1)?.startsWith('- ')).toBe(false);
  });

  it('symbol_transaction_status counts the status code', async () => {
    server = await startTestServer({
      routes: routes({
        'POST /transactionStatus': () =>
          jsonResponse([
            {
              group: 'confirmed',
              code: `Success${ZWSP}`,
              hash: TRANSFER_HASH,
              deadline: '1',
              height: '5763959',
            },
          ]),
      }),
    });
    const result = await server.callTool('symbol_transaction_status', {
      transactionHashes: [TRANSFER_HASH],
    });
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(1);
  });

  it('counts the cached currency alias in every call that shows it, once per call', async () => {
    server = await startTestServer({ routes: routes(currencyAliasRoute(`symbol.xym${ZWSP}`)) });
    for (let call = 0; call < 2; call++) {
      // symbol_network_info shows the alias twice (summary and currency.alias): still 1.
      const info = await server.callTool('symbol_network_info');
      expect(info.structuredContent?.invisibleCharactersRemoved).toBe(1);
    }
    const fees = await server.callTool('symbol_fee_estimate');
    expect(fees.structuredContent?.invisibleCharactersRemoved).toBe(1);
  });

  it('symbol_namespace_get counts a parent shared by two names once', async () => {
    server = await startTestServer({
      routes: routes({
        'POST /namespaces/names': [
          { id: 'E74B99BA41F4AFEE', name: `xym${ZWSP}`, parentId: 'A95F1F8A96159516' },
          { id: 'A95F1F8A96159516', name: `sym${ZWSP}bol${ESC}` },
        ],
      }),
    });
    const result = await server.callTool('symbol_namespace_get', { namespace: 'symbol.xym' });
    // "symbol" (2) appears as a level and inside "symbol.xym"; "xym" (1).
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(3);
  });

  it('symbol_transaction_search counts each message, and the alias shared by all rows once', async () => {
    const transfer = fixture<{ transaction: Record<string, unknown> }>(
      'mainnet/transaction-transfer.json',
    );
    const row = (message: string) => ({
      ...transfer,
      transaction: {
        ...transfer.transaction,
        message: `00${Buffer.from(message, 'utf8').toString('hex')}`,
      },
    });
    server = await startTestServer({
      routes: routes({
        ...currencyAliasRoute(`symbol.xym${ZWSP}`),
        'GET /transactions/confirmed': {
          data: [row(`thanks${ZWSP}`), row(`see you${ESC}[0m`)],
          pagination: { pageNumber: 1, pageSize: 10 },
        },
      }),
    });
    const result = await server.callTool('symbol_transaction_search', {
      address: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY',
    });
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(3);
  });

  it('symbol_holdings_value counts priceSource and priceAsOf', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_holdings_value', {
      account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY',
      unitPrice: '12.34',
      currency: 'JPY',
      priceSource: `Zaif${ZWSP} XYM/JPY`,
      priceAsOf: `2026-09-22${ZWSP}T21:00:00+09:00`,
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(2);
    expect(result.structuredContent?.price).toMatchObject({
      source: 'Zaif XYM/JPY',
      asOf: '2026-09-22T21:00:00+09:00',
    });
  });

  it('does not count the currency alias when no shown fee or mosaic uses it', async () => {
    const transfer = fixture<{
      meta: Record<string, unknown>;
      transaction: Record<string, unknown>;
    }>('mainnet/transaction-transfer.json');
    const { feeMultiplier: _fee, ...meta } = transfer.meta;
    const { maxFee: _max, ...transaction } = transfer.transaction;
    server = await startTestServer({
      routes: routes({
        ...currencyAliasRoute(`symbol.xym${ZWSP}`),
        [`GET /transactions/confirmed/${TRANSFER_HASH}`]: {
          ...transfer,
          meta,
          transaction: { ...transaction, mosaics: [] },
        },
      }),
    });
    const result = await server.callTool('symbol_transaction_get', {
      transactionHash: TRANSFER_HASH,
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(0);
  });
});

describe('text with nothing left after cleaning', () => {
  it('a currency alias of hidden characters only falls back to the mosaic id, and counts', async () => {
    server = await startTestServer({ routes: routes(currencyAliasRoute(`${ZWSP}${ZWSP}`)) });
    const result = await server.callTool('symbol_network_info');
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(2);
    expect(result.structuredContent?.currency).toMatchObject({ alias: null });
    expect(String(result.structuredContent?.summary)).toContain(
      'Currency 6BED913FA20223F8 = mosaic 6BED913FA20223F8',
    );
  });

  it('a namespace level of hidden characters only leaves the name the caller typed', async () => {
    server = await startTestServer({
      routes: routes({
        'POST /namespaces/names': [
          { id: 'E74B99BA41F4AFEE', name: 'xym', parentId: 'A95F1F8A96159516' },
          { id: 'A95F1F8A96159516', name: `${ZWSP}${cp(0x2066)}` },
        ],
      }),
    });
    const result = await server.callTool('symbol_namespace_get', { namespace: 'symbol.xym' });
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(2);
    expect(result.structuredContent?.name).toBe('symbol.xym');
    expect(result.structuredContent?.levels).toEqual([
      { id: 'A95F1F8A96159516', name: null },
      { id: 'E74B99BA41F4AFEE', name: null },
    ]);
  });

  it('a priceSource of hidden characters only counts as not given', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_holdings_value', {
      account: 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY',
      unitPrice: '12.34',
      currency: 'JPY',
      priceSource: `${ZWSP}${cp(0x09)}`,
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.structuredContent?.invisibleCharactersRemoved).toBe(1);
    expect(result.structuredContent?.price).toMatchObject({ source: null });
    expect(String(result.structuredContent?.summary)).toContain('(price supplied by the caller)');
  });
});
