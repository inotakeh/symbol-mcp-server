/**
 * A time from the node that cannot be shown as a date, in every place a tool meets one: a
 * timestamp no Date can hold (any digits pass the uint64 schema of the REST client), and a date
 * estimated from a height or an epoch too far from the current one. Each place answers with the one
 * text of describeError, never with "Unexpected internal error", quotes no value in the reply and
 * writes the details to stderr. symbol_time_convert and symbol_transaction_status word some cases
 * themselves; their own test files have those.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSISTENT_DELEGATION_MARKER } from '../../src/domain/message.js';
import {
  UNUSABLE_TIME_ADVICE,
  unusableTimeDetail,
  unusableTimeText,
} from '../../src/tools/_shared.js';
import {
  fixture,
  H,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
  TRANSFER_HASH,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const PUBLIC_KEY = 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E';
const MAIN_HEX = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';

/** Beyond the last date JavaScript knows. */
const BEYOND = '9000000000000000';
/** Too long to be a finite number. */
const TOO_LONG = '9'.repeat(400);
/** A height or a duration whose estimated date lies beyond the last date. */
const FAR_HEIGHT = '1000000000000';
const FAR_EPOCH = 4_000_000_000;

const LOG = `symbol-mcp-server: unusable time from node ${TEST_NODE_HOST}: `;
const TIMESTAMP_ERROR = 'InvalidNetworkTimestampError: invalid network timestamp: ';
const DATE_ERROR = 'InvalidDateError: the date holds no valid time (outside the range of Date)';

type Json = Record<string, unknown>;

function block(height: number, timestamp: string) {
  const doc = fixture<{ block: Json }>('mainnet/block-5763675.json');
  return { ...doc, block: { ...doc.block, height: String(height), timestamp } };
}

function transfer(change: { timestamp?: string; deadline?: string }) {
  const doc = fixture<{ meta: Json; transaction: Json }>('mainnet/transaction-transfer.json');
  return {
    ...doc,
    meta: { ...doc.meta, ...(change.timestamp ? { timestamp: change.timestamp } : {}) },
    transaction: {
      ...doc.transaction,
      ...(change.deadline ? { deadline: change.deadline } : {}),
    },
  };
}

function searchPage(timestamp: string) {
  const page = fixture<{ data: Array<{ meta: Json }> }>('mainnet/transactions-search.json');
  const [first, ...rest] = page.data;
  if (!first) throw new Error('fixture row missing');
  return { ...page, data: [{ ...first, meta: { ...first.meta, timestamp } }, ...rest] };
}

/** A transfer page whose newest row is a delegation request confirmed at `timestamp`. */
function delegationRequestPage(timestamp: string) {
  const request = {
    meta: {
      height: '5763000',
      hash: H('fixture:delegation-request-hash'),
      merkleComponentHash: H('fixture:delegation-request-hash'),
      index: 0,
      timestamp,
      feeMultiplier: 100,
    },
    transaction: {
      size: 300,
      signature: H('fixture:delegation-request-sig:a') + H('fixture:delegation-request-sig:b'),
      signerPublicKey: PUBLIC_KEY,
      version: 1,
      network: 104,
      type: 16724,
      maxFee: '30000',
      deadline: '173142863808',
      recipientAddress: MAIN_HEX,
      mosaics: [],
      message: PERSISTENT_DELEGATION_MARKER + H('fixture:delegation-request-payload'),
    },
    id: H('fixture:doc-id-delegation-request').slice(0, 24),
  };
  return { data: [request], pagination: { pageNumber: 1, pageSize: 100 } };
}

function harvestStatement(timestamp: string) {
  const page = fixture<{ data: Array<{ meta: Json }> }>('mainnet/statement-harvest-one-block.json');
  return { ...page, data: page.data.map((row) => ({ ...row, meta: { ...row.meta, timestamp } })) };
}

function namespaceEndingAt(endHeight: string) {
  const doc = fixture<{ namespace: Json }>('mainnet/namespace-symbol.json');
  return { ...doc, namespace: { ...doc.namespace, endHeight } };
}

function mosaicLasting(duration: string) {
  const doc = fixture<{ mosaic: Json }>('mainnet/mosaic-other.json');
  return { ...doc, mosaic: { ...doc.mosaic, duration } };
}

function accountWithEndEpoch(endEpoch: number) {
  const doc = fixture<{
    account: { supplementalPublicKeys: { voting: { publicKeys: Json[] } } } & Json;
  }>('mainnet/account-voting.json');
  const keys = doc.account.supplementalPublicKeys.voting.publicKeys;
  return {
    ...doc,
    account: {
      ...doc.account,
      supplementalPublicKeys: {
        ...doc.account.supplementalPublicKeys,
        // The second key is the active one.
        voting: { publicKeys: keys.map((key, i) => (i === 1 ? { ...key, endEpoch } : key)) },
      },
    },
  };
}

function properties(epochAdjustment: string) {
  const doc = fixture<{ network: Json }>('mainnet/network-properties.json');
  return { ...doc, network: { ...doc.network, epochAdjustment } };
}

/** The block clock of harvesting_income.test.ts: 30 s for each block around a captured block. */
const INCOME_NOW = new Date('2026-09-12T08:00:00.000Z');
function incomeByDateRoutes(): Routes {
  const chain = fixture<Json>('mainnet/chain-info.json');
  const blockAt = (height: number) => {
    const ts = Math.max(0, 173_192_454_149 + (height - 5_764_879) * 30_000);
    return { meta: {}, block: { height: String(height), timestamp: String(ts) } };
  };
  return {
    ...mainnetRoutes(),
    'GET /chain/info': { ...chain, height: '5770000' },
    'GET /blocks/*': (_request: Request, url: URL) =>
      jsonResponse(blockAt(Number(url.pathname.split('/').pop()))),
  };
}

// A namespace and a mosaic that expire, so that their end date is estimated.
const EXPIRING: Routes = {
  'GET /namespaces/A95F1F8A96159516': namespaceEndingAt('6000000'),
  'GET /mosaics/66BAE04E8758599E': mosaicLasting('5000000'),
};

interface Place {
  /** What cannot be used, for the test title. */
  readonly what: string;
  readonly tool: string;
  readonly args: Json;
  /** Routes with which the same call answers. */
  readonly usable: Routes;
  /** The routes that differ when the time cannot be used. */
  readonly unusable: Routes;
  /** What stderr says after the prefix. */
  readonly logged: string;
  readonly now?: Date;
}

const HEIGHT_RANGE = { account: ADDRESS, fromHeight: 5_763_675, toHeight: 5_763_675 };

/** Every place that converts a time the node sent. */
const CONVERSIONS: Place[] = [
  {
    what: 'the block time of a transaction',
    tool: 'symbol_transaction_get',
    args: { transactionHash: TRANSFER_HASH },
    usable: {},
    unusable: { [`GET /transactions/confirmed/${TRANSFER_HASH}`]: transfer({ timestamp: BEYOND }) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the deadline of a transaction',
    tool: 'symbol_transaction_get',
    args: { transactionHash: TRANSFER_HASH },
    usable: {},
    unusable: { [`GET /transactions/confirmed/${TRANSFER_HASH}`]: transfer({ deadline: BEYOND }) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the block time of a row',
    tool: 'symbol_transaction_search',
    args: { address: ADDRESS },
    usable: {},
    unusable: { 'GET /transactions/confirmed': searchPage(BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the time of the delegation request',
    tool: 'symbol_delegation_diagnose',
    args: { account: ADDRESS },
    usable: { 'GET /transactions/confirmed': delegationRequestPage('173135863808') },
    unusable: { 'GET /transactions/confirmed': delegationRequestPage(BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the time of the delegation request, too long for a number',
    tool: 'symbol_delegation_diagnose',
    args: { account: ADDRESS },
    usable: { 'GET /transactions/confirmed': delegationRequestPage('173135863808') },
    unusable: { 'GET /transactions/confirmed': delegationRequestPage(TOO_LONG) },
    // The tool reads this time as a number first.
    logged: `${TIMESTAMP_ERROR}Infinity`,
  },
  {
    what: 'the time of a harvest statement',
    tool: 'symbol_delegation_diagnose',
    args: { account: ADDRESS },
    usable: {},
    unusable: { 'GET /statements/transaction': harvestStatement(BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the time of the first block of the range',
    tool: 'symbol_harvesting_income',
    args: HEIGHT_RANGE,
    usable: {},
    unusable: { 'GET /blocks/5763675': block(5_763_675, BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the time of the first block of the range, too long for a number',
    tool: 'symbol_harvesting_income',
    args: HEIGHT_RANGE,
    usable: {},
    unusable: { 'GET /blocks/5763675': block(5_763_675, TOO_LONG) },
    logged: `${TIMESTAMP_ERROR}Infinity`,
  },
  {
    what: 'the time of the last block of the range only',
    tool: 'symbol_harvesting_income',
    args: { account: ADDRESS, fromHeight: 5_753_675, toHeight: 5_763_675 },
    usable: {},
    unusable: { 'GET /blocks/5763675': block(5_763_675, BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the time of block 1, for a period given as dates',
    tool: 'symbol_harvesting_income',
    args: { account: ADDRESS, fromDate: '2026-09-10', toDate: '2026-09-10' },
    usable: incomeByDateRoutes(),
    unusable: { 'GET /blocks/1': block(1, BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
    now: INCOME_NOW,
  },
  {
    what: 'the time of a harvest statement',
    tool: 'symbol_harvesting_income',
    args: HEIGHT_RANGE,
    usable: {},
    unusable: { 'GET /statements/transaction': harvestStatement(BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the block time of a past height',
    tool: 'symbol_time_convert',
    args: { height: 5_763_000 },
    usable: { 'GET /blocks/5763000': block(5_763_000, '173135863808') },
    unusable: { 'GET /blocks/5763000': block(5_763_000, BEYOND) },
    logged: `${TIMESTAMP_ERROR}${BEYOND}`,
  },
  {
    what: 'the epoch adjustment',
    tool: 'symbol_network_info',
    args: {},
    usable: {},
    unusable: { 'GET /network/properties': properties(`${BEYOND}s`) },
    logged: DATE_ERROR,
  },
];

/** The tools that use the average block time, each with a call that measures it. */
const ESTIMATING: ReadonlyArray<readonly [string, Json]> = [
  ['symbol_time_convert', { timestamp: 173_156_113_808 }],
  ['symbol_voting_key_status', { account: ADDRESS }],
  ['symbol_delegation_diagnose', { account: ADDRESS }],
  ['symbol_namespace_get', { namespace: 'symbol' }],
  ['symbol_mosaic_get', { mosaic: '66BAE04E8758599E' }],
];
/** The two blocks the average is measured from: the latest, and the one 10,000 blocks before. */
const MEASURED_BLOCKS: ReadonlyArray<readonly [string, Routes, string]> = [
  [
    'the latest block',
    { 'GET /blocks/5763675': block(5_763_675, BEYOND) },
    `${TIMESTAMP_ERROR}${BEYOND}`,
  ],
  [
    'the latest block, too long for a number',
    { 'GET /blocks/5763675': block(5_763_675, TOO_LONG) },
    // Cut at the cap of an untrusted string.
    `${TIMESTAMP_ERROR}${'9'.repeat(50)}`,
  ],
  [
    'the older block',
    { 'GET /blocks/5753675': block(5_753_675, BEYOND) },
    `${TIMESTAMP_ERROR}${BEYOND}`,
  ],
];
const AVERAGES: Place[] = ESTIMATING.flatMap(([tool, args]) =>
  MEASURED_BLOCKS.map(([what, unusable, logged]) => ({
    what: `the time of ${what}`,
    tool,
    args,
    usable: EXPIRING,
    unusable,
    logged,
  })),
);

/** Estimates that leave the range of a date, with block times that are usable. */
const ESTIMATES: Place[] = [
  {
    what: 'an end height too far away',
    tool: 'symbol_namespace_get',
    args: { namespace: 'symbol' },
    usable: EXPIRING,
    unusable: { 'GET /namespaces/A95F1F8A96159516': namespaceEndingAt(FAR_HEIGHT) },
    logged: DATE_ERROR,
  },
  {
    what: 'a duration too long',
    tool: 'symbol_mosaic_get',
    args: { mosaic: '66BAE04E8758599E' },
    usable: EXPIRING,
    unusable: { 'GET /mosaics/66BAE04E8758599E': mosaicLasting(FAR_HEIGHT) },
    logged: DATE_ERROR,
  },
  {
    what: 'the end epoch of a voting key too far away',
    tool: 'symbol_voting_key_status',
    args: { account: ADDRESS },
    usable: {},
    unusable: { [`GET /accounts/${ADDRESS}`]: accountWithEndEpoch(FAR_EPOCH) },
    logged: DATE_ERROR,
  },
];

const PLACES = [...CONVERSIONS, ...AVERAGES, ...ESTIMATES];
const title = (place: Place) => `${place.tool}: ${place.what}`;
/** Each distinct call of the table (tool, arguments, routes that differ from the default), once. */
const CALLS = [
  ...new Map(
    PLACES.map((place) => [
      `${place.tool} ${JSON.stringify(place.args)} ${Object.keys(place.usable).join(' ')}`,
      place,
    ]),
  ).values(),
];

describe('a time from the node that cannot be shown as a date', () => {
  it('is worded once, for every place, as what happened and what to do', () => {
    expect(unusableTimeText('node.test:3001')).toBe(
      'Node node.test:3001 returned a time that cannot be shown as a date (a timestamp, or a height or an epoch too far from now), so this answer could not be completed. If it happens for one transaction, account, namespace or mosaic only, the data the node holds for it is unusual: ask for the other items separately. If it happens for every call, the node may be faulty: point SYMBOL_NODE_URL at another node (see https://nodewatch.symbol.tools/). Details were written to stderr (the server log).',
    );
    // It is made of two parts, which the CLI check prints as the detail and the hint of an item.
    // They are kept apart instead of split from the text: a host can end in a dot.
    for (const host of [TEST_NODE_HOST, 'node.test.']) {
      expect(unusableTimeDetail(host)).toBe(
        `Node ${host} returned a time that cannot be shown as a date (a timestamp, or a height or an epoch too far from now), so this answer could not be completed.`,
      );
      expect(unusableTimeText(host)).toBe(`${unusableTimeDetail(host)} ${UNUSABLE_TIME_ADVICE}`);
    }
    expect(UNUSABLE_TIME_ADVICE).toMatch(/^If it happens for one transaction, /);
  });

  it.each(PLACES.map((place) => [title(place), place] as const))(
    'fails the call with that text and nothing of the value: %s',
    async (_title, place) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      server = await startTestServer({
        routes: { ...mainnetRoutes(), ...place.usable, ...place.unusable },
        ...(place.now ? { now: place.now } : {}),
      });
      const result = await server.callTool(place.tool, place.args);
      expect(result.isError).toBe(true);
      expect(result.text).toBe(unusableTimeText(TEST_NODE_HOST));
      expect(result.text).not.toMatch(/Unexpected internal error|Invalid time value/);
      expect(result.structuredContent).toBeUndefined();
      // Nothing of the value in the reply: not the digits, not a height, not an epoch.
      for (const value of [BEYOND, '9'.repeat(20), FAR_HEIGHT, String(FAR_EPOCH), 'Infinity']) {
        expect(result.text).not.toContain(value);
      }
      // The details are on stderr, under their own heading, cleaned and capped.
      const logged = errors.mock.calls.map((call) => String(call[0]));
      expect(logged).toHaveLength(1);
      expect(logged[0]?.startsWith(`${LOG}${place.logged}`)).toBe(true);
      expect(logged[0]).not.toContain('9'.repeat(300));
      expect(logged[0]).not.toMatch(/unexpected internal error/);
    },
  );

  it.each(CALLS.map((place) => [`${place.tool} ${JSON.stringify(place.args)}`, place] as const))(
    'answers the same call when the times can be used: %s',
    async (_call, place) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      server = await startTestServer({
        routes: { ...mainnetRoutes(), ...place.usable },
        ...(place.now ? { now: place.now } : {}),
      });
      const result = await server.callTool(place.tool, place.args);
      expect(result.isError, result.text).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    },
  );
});
