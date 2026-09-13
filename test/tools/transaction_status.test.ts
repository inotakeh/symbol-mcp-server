import { afterEach, describe, expect, it } from 'vitest';
import {
  jsonResponse,
  mainnetRoutes,
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
