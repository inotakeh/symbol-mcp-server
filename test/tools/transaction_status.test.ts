import { afterEach, describe, expect, it, vi } from 'vitest';
import { unusableTimeText } from '../../src/tools/_shared.js';
import {
  fixture,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  STATUS_HASH_FAILED,
  STATUS_HASH_PARTIAL,
  STATUS_HASH_UNCONFIRMED,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
  TRANSFER_HASH,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const UNKNOWN_HASH = 'A'.repeat(64);
/** epochAdjustment 1615853185 s + deadline 173168162072 ms (transaction-status.json). */
const TRANSFER_DEADLINE_UTC = '2026-09-10T06:22:27.072Z';

type StatusRow = {
  hash: string;
  group: string;
  code: string | null;
  codeMeaning: string | null;
  height: number | null;
  deadline: { utc: string; local?: string } | null;
};

describe('symbol_transaction_status', () => {
  it('reports every group and not_found in input order from one POST', async () => {
    server = await startTestServer({ env: { SYMBOL_TIMEZONE: 'Asia/Tokyo' } });
    const result = await server.callTool('symbol_transaction_status', {
      transactionHashes: [
        TRANSFER_HASH.toLowerCase(),
        STATUS_HASH_UNCONFIRMED,
        STATUS_HASH_PARTIAL,
        STATUS_HASH_FAILED,
        UNKNOWN_HASH,
      ],
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { statuses: StatusRow[]; counts: unknown };
    expect(sc.statuses.map((s) => s.group)).toEqual([
      'confirmed',
      'unconfirmed',
      'partial',
      'failed',
      'not_found',
    ]);
    expect(sc.statuses[0]).toEqual({
      hash: TRANSFER_HASH,
      group: 'confirmed',
      code: 'Success',
      codeMeaning: null,
      height: 5_763_959,
      deadline: { utc: TRANSFER_DEADLINE_UTC, local: '2026-09-10T15:22:27+09:00' },
    });
    expect(sc.statuses[1]).toMatchObject({ group: 'unconfirmed', code: 'Success', height: null });
    expect(sc.statuses[2]).toMatchObject({ group: 'partial', height: null });
    expect(sc.statuses[3]).toMatchObject({
      group: 'failed',
      code: 'Failure_Core_Insufficient_Balance',
      codeMeaning: 'Validation failed because the account has an insufficient balance.',
      height: null,
    });
    expect(sc.statuses[4]).toEqual({
      hash: UNKNOWN_HASH,
      group: 'not_found',
      code: null,
      codeMeaning: null,
      height: null,
      deadline: null,
    });
    expect(sc.counts).toEqual({
      confirmed: 1,
      unconfirmed: 1,
      partial: 1,
      failed: 1,
      notFound: 1,
    });

    const summary = result.structuredContent?.summary as string;
    expect(summary).toMatch(
      /5 transactions checked on mainnet .*: 1 confirmed, 1 unconfirmed, 1 partial, 1 failed, 1 not found\./,
    );
    expect(summary).toMatch(/FAEEB042… confirmed at height 5,763,959\./);
    expect(summary).toMatch(/unconfirmed: accepted into the mempool/);
    expect(summary).toMatch(
      /partial: waiting for cosignatures \(aggregate bonded with missing cosignatures/,
    );
    expect(summary).toMatch(
      /failed: Failure_Core_Insufficient_Balance \(Validation failed because the account has an insufficient balance\.\)/,
    );
    expect(summary).toMatch(/AAAAAAAA… not found on this node/);
    expect(JSON.parse(result.text)).toEqual(result.structuredContent);

    // One POST with the hashes upper-cased, only to the configured host.
    const posts = server.requests.filter((u) => u.pathname === '/transactionStatus');
    expect(posts).toHaveLength(1);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('collapses duplicate hashes and still answers a single hash as an array', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_transaction_status', {
      transactionHashes: [TRANSFER_HASH, TRANSFER_HASH.toLowerCase(), ` ${TRANSFER_HASH} `],
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { statuses: StatusRow[] };
    expect(sc.statuses).toHaveLength(1);
    expect(sc.statuses[0]?.group).toBe('confirmed');
    expect(result.structuredContent?.summary).toMatch(/^1 transaction checked/);
  });

  it('treats a 404 for the whole batch as not_found, not as an error', async () => {
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'POST /transactionStatus': () => jsonResponse({}, 404) },
    });
    const result = await server.callTool('symbol_transaction_status', {
      transactionHashes: [TRANSFER_HASH, UNKNOWN_HASH],
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { statuses: StatusRow[]; counts: { notFound: number } };
    expect(sc.statuses.map((s) => s.group)).toEqual(['not_found', 'not_found']);
    expect(sc.counts.notFound).toBe(2);
  });

  it('answers with an error, not not_found, when the status request fails otherwise', async () => {
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'POST /transactionStatus': () => jsonResponse({}, 500) },
    });
    const result = await server.callTool('symbol_transaction_status', {
      transactionHashes: [TRANSFER_HASH],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/answered HTTP 500 for \/transactionStatus/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects malformed hashes with a hint and without contacting the node', async () => {
    server = await startTestServer();
    const before = server.requests.length;
    for (const bad of ['abc', 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY', 'G'.repeat(64)]) {
      const result = await server.callTool('symbol_transaction_status', {
        transactionHashes: [TRANSFER_HASH, bad],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/is not a transaction hash/);
      expect(result.text).toMatch(/64-character hex hash/);
    }
    expect(server.requests.length).toBe(before);
  });

  it('rejects more than 20 hashes with a batching hint', async () => {
    server = await startTestServer();
    const hashes = Array.from({ length: 21 }, (_, i) =>
      i.toString(16).toUpperCase().padStart(64, '0'),
    );
    const result = await server.callTool('symbol_transaction_status', {
      transactionHashes: hashes,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/21 hashes were given but at most 20/);
    expect(result.text).toMatch(/batches of 20/);
    expect(server.requests.filter((u) => u.pathname === '/transactionStatus')).toHaveLength(0);
  });

  it('rejects an empty list with a hint', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_transaction_status', { transactionHashes: [] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/transactionHashes is empty/);
  });
});

describe('symbol_transaction_status: a deadline that gives no date', () => {
  afterEach(() => vi.restoreAllMocks());

  // Any digits pass the schema of a deadline: beyond the last date, and too long for a number.
  const BEYOND = '9000000000000000';
  const TOO_LONG = '9'.repeat(400);
  const FAILED = `${STATUS_HASH_FAILED.slice(0, 8)}…`;
  const UNCONFIRMED = `${STATUS_HASH_UNCONFIRMED.slice(0, 8)}…`;
  const GET_HINT =
    ' For a failed transaction, symbol_transaction_get reports the validation code and its meaning without reading the deadline.';
  const LOG = `symbol-mcp-server: unusable time from node ${TEST_NODE_HOST}: `;

  /** The default status rows, with the deadline of the given hashes replaced. */
  function routesWithDeadlines(deadlines: Record<string, string>): Routes {
    return {
      ...mainnetRoutes(),
      'POST /transactionStatus': async (request: Request) => {
        const body = (await request.json()) as { hashes?: string[] };
        const wanted = new Set((body.hashes ?? []).map((h) => h.toUpperCase()));
        const rows = fixture<Array<{ hash: string; deadline: string }>>(
          'mainnet/transaction-status.json',
        );
        return jsonResponse(
          rows
            .filter((row) => wanted.has(row.hash))
            .map((row) => ({ ...row, deadline: deadlines[row.hash] ?? row.deadline })),
        );
      },
    };
  }
  const status = (transactionHashes: string[]) => {
    if (server === undefined) throw new Error('start the server first');
    return server.callTool('symbol_transaction_status', { transactionHashes });
  };

  it('names the transaction and its group, and says to ask again without it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startTestServer({
      routes: routesWithDeadlines({ [STATUS_HASH_FAILED]: BEYOND }),
    });
    const result = await status([TRANSFER_HASH, STATUS_HASH_FAILED]);
    expect(result.isError).toBe(true);
    expect(FAILED).toBe('9539AD0F…');
    expect(result.text).toBe(
      `Node node.test:3001 reports a deadline that cannot be shown as a date for transaction 9539AD0F… (failed), so no status of this call could be returned. Call symbol_transaction_status again without that hash.${GET_HINT}`,
    );
    expect(result.structuredContent).toBeUndefined();
    // Neither the deadline nor a whole hash is in the reply; the deadline is on stderr.
    expect(result.text).not.toContain(BEYOND);
    expect(result.text).not.toContain(STATUS_HASH_FAILED);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      `${LOG}InvalidNetworkTimestampError: invalid network timestamp: ${BEYOND}`,
    ]);

    // As the text says: the same call without that hash answers.
    const again = await status([TRANSFER_HASH]);
    expect(again.isError).toBe(false);
    expect(again.structuredContent).toMatchObject({
      statuses: [{ hash: TRANSFER_HASH, group: 'confirmed' }],
    });
  });

  it('names every transaction concerned, in the order asked', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startTestServer({
      routes: routesWithDeadlines({
        [STATUS_HASH_FAILED]: BEYOND,
        [STATUS_HASH_UNCONFIRMED]: BEYOND,
      }),
    });
    const text = (rows: string) =>
      `Node ${TEST_NODE_HOST} reports a deadline that cannot be shown as a date for transactions ${rows}, so no status of this call could be returned. Call symbol_transaction_status again without those hashes.${GET_HINT}`;
    const both = await status([STATUS_HASH_FAILED, TRANSFER_HASH, STATUS_HASH_UNCONFIRMED]);
    expect(both.isError).toBe(true);
    expect(both.text).toBe(text(`${FAILED} (failed), ${UNCONFIRMED} (unconfirmed)`));
    // One line on stderr for each of them.
    const line = `${LOG}InvalidNetworkTimestampError: invalid network timestamp: ${BEYOND}`;
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([line, line]);
    const reversed = await status([STATUS_HASH_UNCONFIRMED, STATUS_HASH_FAILED]);
    expect(reversed.text).toBe(text(`${UNCONFIRMED} (unconfirmed), ${FAILED} (failed)`));
  });

  it('points to symbol_transaction_get only when a transaction concerned is failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startTestServer({
      routes: routesWithDeadlines({ [STATUS_HASH_UNCONFIRMED]: BEYOND }),
    });
    const result = await status([STATUS_HASH_UNCONFIRMED, STATUS_HASH_FAILED]);
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Node ${TEST_NODE_HOST} reports a deadline that cannot be shown as a date for transaction ${UNCONFIRMED} (unconfirmed), so no status of this call could be returned. Call symbol_transaction_status again without that hash.`,
    );
    expect(result.text).not.toContain('symbol_transaction_get');
  });

  it('gives the same text for a deadline too long for a number, and cuts it on stderr', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startTestServer({
      routes: routesWithDeadlines({ [STATUS_HASH_FAILED]: TOO_LONG }),
    });
    const result = await status([STATUS_HASH_FAILED]);
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Node ${TEST_NODE_HOST} reports a deadline that cannot be shown as a date for transaction ${FAILED} (failed), so no status of this call could be returned. Call symbol_transaction_status again without that hash.${GET_HINT}`,
    );
    expect(result.text).not.toContain('9'.repeat(16));
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toHaveLength(1);
    expect(
      logged[0]?.startsWith(
        `${LOG}InvalidNetworkTimestampError: invalid network timestamp: ${'9'.repeat(50)}`,
      ),
    ).toBe(true);
    expect(logged[0]).not.toContain('9'.repeat(300));
  });

  it('gives the general text when the epoch adjustment is what gives no date', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const properties = fixture<{ network: Record<string, string> }>(
      'mainnet/network-properties.json',
    );
    properties.network.epochAdjustment = `${BEYOND}s`;
    server = await startTestServer({
      routes: { ...mainnetRoutes(), 'GET /network/properties': properties },
    });
    // Every deadline fails then, and none is the fault of its transaction.
    const result = await status([TRANSFER_HASH, STATUS_HASH_FAILED]);
    expect(result.isError).toBe(true);
    expect(result.text).toBe(unusableTimeText(TEST_NODE_HOST));
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      `${LOG}InvalidDateError: the date holds no valid time (outside the range of Date)`,
    ]);
    // A call that converts no deadline still answers, as before.
    const unknown = await status([UNKNOWN_HASH]);
    expect(unknown.isError).toBe(false);
    expect(unknown.structuredContent).toMatchObject({ counts: { notFound: 1 } });
  });
});
