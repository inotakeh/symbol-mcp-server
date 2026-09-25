import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { base32AddressToHex, publicKeyToAddress } from '../../src/domain/address.js';
import { PERSISTENT_DELEGATION_MARKER } from '../../src/domain/message.js';
import { delegationDiagnoseTool } from '../../src/tools/symbol_delegation_diagnose.js';
import {
  fixture,
  jsonResponse,
  mainnetRoutes,
  type Routes,
  startTestServer,
  TEST_NODE_HOST,
  type TestServer,
} from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const PUBLIC_KEY = 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E';
const LINKED = '54E48E0C3625F1AC6DE5A8B2CD495D1DA3140745FD28145C9BCDE4FDA16F992B';
const NODE_KEY = 'CEF91B106670BC3FDD3614D8B9E816DAA3286817F79A99F902BDC9CD73EF3568';
const XYM = '6BED913FA20223F8';
const MAIN_HEX = '68ABD3C432290D37B428A3C3501AD7B5F3CD8B936BA14C53';

type Check = { id: string; status: string; detail: string; hint: string | null };
type Output = {
  verdict: string;
  checks: Check[];
  summary: string;
  recentHarvest: { receipts: number; lastHeight: number | null } | null;
  account: { keys: { linked: string | null; vrf: string | null; node: string | null } };
  node: { configuredNodePublicKey: string | null; unlockedCount: number | null };
  notes: string[];
};

const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();

function accountFixture() {
  return fixture<{ account: Record<string, unknown> }>('mainnet/account-voting.json');
}

function statusOf(out: Output, id: string): string {
  const c = out.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing`);
  return c.status;
}

const EXPECTED_ORDER = [
  'account_exists',
  'balance_in_range',
  'importance_positive',
  'linked_key',
  'vrf_key',
  'node_key',
  'node_key_matches_configured_node',
  'unlocked_on_node',
  'account_type',
  'recent_harvest',
  'delegation_request_found',
];

/** A transfer page whose newest row is a delegation request to `recipientHex` (synthetic values). */
function delegationRequestPage(recipientHex: string) {
  const captured = fixture<{ data: unknown[] }>('mainnet/transactions-search.json');
  const request = {
    meta: {
      height: '5763000',
      hash: H('fixture:delegation-request-hash'),
      merkleComponentHash: H('fixture:delegation-request-hash'),
      index: 0,
      timestamp: '173135863808',
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
      recipientAddress: recipientHex,
      mosaics: [],
      message: PERSISTENT_DELEGATION_MARKER + H('fixture:delegation-request-payload'),
    },
    id: H('fixture:doc-id-delegation-request').slice(0, 24),
  };
  return { data: [request, ...captured.data], pagination: { pageNumber: 1, pageSize: 100 } };
}

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

describe('symbol_delegation_diagnose', () => {
  it('reports active for the fixture account and only talks to the configured node', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('active');
    expect(out.checks.map((c) => c.id)).toEqual(EXPECTED_ORDER);
    for (const id of EXPECTED_ORDER.slice(0, 10)) expect(statusOf(out, id)).toBe('ok');
    // The captured transfer page holds no delegation request: informational warning, still active.
    expect(statusOf(out, 'delegation_request_found')).toBe('warn');
    // The account delegates to the configured node: its node key is the node's public key.
    expect(out.account.keys).toMatchObject({ linked: LINKED, node: NODE_KEY });
    expect(out.node).toEqual({ configuredNodePublicKey: NODE_KEY, unlockedCount: 15 });
    expect(out.recentHarvest).toMatchObject({ receipts: 1, lastHeight: 5764879 });
    expect(out.summary.split('\n')[0]).toBe(`delegated harvesting: active (${ADDRESS}).`);
    expect(out.summary).toMatch(/delegation_request_found warn/);
    // concise: ok checks carry no hint, others do.
    expect(out.checks.filter((c) => c.status === 'ok').every((c) => c.hint === null)).toBe(true);
    expect(out.checks.find((c) => c.status === 'warn')?.hint).toMatch(/top-level transfers/);
    expect(delegationDiagnoseTool.outputSchema.safeParse(out).success).toBe(true);
    expect(JSON.parse(result.text)).toEqual(out);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
    const paths = server.requests.map((u) => u.pathname);
    for (const p of [
      `/accounts/${ADDRESS}`,
      '/node/info',
      '/node/unlockedaccount',
      '/statements/transaction',
      '/transactions/confirmed',
    ]) {
      expect(paths).toContain(p);
    }
    const search = server.requests.find((u) => u.pathname === '/transactions/confirmed');
    expect(search?.searchParams.get('signerPublicKey')).toBe(PUBLIC_KEY);
    expect(search?.searchParams.get('type')).toBe('16724');
    expect(search?.searchParams.get('recipientAddress')).toMatch(/^N[A-Z2-7]{38}$/);
  });

  it('finds the delegation request transfer and includes hints for every check when detailed', async () => {
    server = await startTestServer();
    // Ask once to learn the node address the tool derives, then serve a matching request.
    await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    const first = server.requests.find((u) => u.pathname === '/transactions/confirmed');
    const nodeAddress = first?.searchParams.get('recipientAddress');
    expect(nodeAddress).toBeTruthy();
    await server.close();
    const { base32AddressToHex } = await import('../../src/domain/address.js');
    server = await startTestServer({
      routes: routes({
        'GET /transactions/confirmed': delegationRequestPage(base32AddressToHex(nodeAddress ?? '')),
      }),
    });
    const result = await server.callTool('symbol_delegation_diagnose', {
      account: PUBLIC_KEY,
      format: 'detailed',
    });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('active');
    expect(statusOf(out, 'delegation_request_found')).toBe('ok');
    expect(out.checks.find((c) => c.id === 'delegation_request_found')?.detail).toMatch(
      /height 5,763,000/,
    );
    expect(out.checks.every((c) => c.hint !== null)).toBe(true);
    expect(delegationDiagnoseTool.outputSchema.safeParse(out).success).toBe(true);
  });

  it('is not active without a linked key', async () => {
    const account = accountFixture();
    const keys = account.account.supplementalPublicKeys as Record<string, unknown>;
    account.account.supplementalPublicKeys = { vrf: keys.vrf, node: keys.node };
    server = await startTestServer({ routes: routes({ [`GET /accounts/${ADDRESS}`]: account }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('not_active');
    expect(statusOf(out, 'linked_key')).toBe('fail');
    expect(statusOf(out, 'unlocked_on_node')).toBe('fail');
    expect(statusOf(out, 'recent_harvest')).toBe('ok');
    expect(out.summary.split('\n')[0]).toMatch(/^delegated harvesting: not active/);
    expect(out.summary).toMatch(/linked_key fail/);
    expect(out.checks.find((c) => c.id === 'linked_key')?.hint).toMatch(/AccountKeyLink/);
  });

  it('cannot verify node-side checks when the account delegates to another node', async () => {
    const account = accountFixture();
    (account.account.supplementalPublicKeys as Record<string, unknown>).node = {
      publicKey: H('fixture:other-node-key'),
    };
    server = await startTestServer({ routes: routes({ [`GET /accounts/${ADDRESS}`]: account }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('cannot_verify');
    expect(statusOf(out, 'node_key_matches_configured_node')).toBe('warn');
    expect(statusOf(out, 'unlocked_on_node')).toBe('unknown');
    expect(statusOf(out, 'delegation_request_found')).toBe('unknown');
    expect(out.summary).toMatch(/could not verify: unlocked_on_node, delegation_request_found/);
    expect(server.requests.some((u) => u.pathname === '/transactions/confirmed')).toBe(false);
  });

  it('is not active when the balance is below minHarvesterBalance', async () => {
    const account = accountFixture();
    account.account.mosaics = [{ id: XYM, amount: '5000000' }];
    account.account.importance = '0';
    server = await startTestServer({ routes: routes({ [`GET /accounts/${ADDRESS}`]: account }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('not_active');
    expect(statusOf(out, 'balance_in_range')).toBe('fail');
    expect(statusOf(out, 'importance_positive')).toBe('fail');
    expect(out.checks.find((c) => c.id === 'balance_in_range')?.detail).toMatch(
      /5\.000000 symbol\.xym is below minHarvesterBalance 10000\.000000 symbol\.xym/,
    );
    // The minimum itself is enough (catapult: balance >= MinHarvesterBalance), as the ranges of
    // this tool and symbol_harvesting_status say.
    expect(out.checks.find((c) => c.id === 'balance_in_range')?.hint).toBe(
      'Hold at least 10000.000000 symbol.xym on the main account; importance is only assigned to balances at or above that threshold.',
    );
  });

  it('fails balance_in_range above maxHarvesterBalance', async () => {
    const account = accountFixture();
    account.account.mosaics = [{ id: XYM, amount: '50000000000001' }];
    server = await startTestServer({ routes: routes({ [`GET /accounts/${ADDRESS}`]: account }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('not_active');
    expect(out.checks.find((c) => c.id === 'balance_in_range')).toMatchObject({
      status: 'fail',
      detail: expect.stringMatching(/exceeds maxHarvesterBalance/),
      hint: expect.stringMatching(
        /cannot harvest, and nodes drop them from their unlocked list; move the excess/,
      ),
    });
  });

  it('warns and counts blocks to the next recalculation when importance is zero with a good balance', async () => {
    const account = accountFixture();
    account.account.importance = '0';
    server = await startTestServer({ routes: routes({ [`GET /accounts/${ADDRESS}`]: account }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('active');
    const c = out.checks.find((x) => x.id === 'importance_positive');
    expect(c?.status).toBe('warn');
    // chain height 5,763,675, importanceGrouping 720 -> next multiple 5,764,320, 645 blocks away.
    expect(c?.hint).toMatch(/height 5,764,320, about 645 blocks away \(importanceGrouping 720\)/);
  });

  it('warns on the account type when given a remote-style account', async () => {
    const account = accountFixture();
    account.account.accountType = 2;
    server = await startTestServer({ routes: routes({ [`GET /accounts/${ADDRESS}`]: account }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    const out = result.structuredContent as unknown as Output;
    expect(out.checks.find((x) => x.id === 'account_type')).toMatchObject({
      status: 'warn',
      hint: expect.stringMatching(/diagnose the main account/),
    });
  });

  it('answers not_active with only account_exists failing when the account is unknown', async () => {
    server = await startTestServer({
      routes: routes({ [`GET /accounts/${ADDRESS}`]: () => jsonResponse({}, 404) }),
    });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('not_active');
    expect(out.checks.map((c) => c.id)).toEqual(EXPECTED_ORDER);
    expect(statusOf(out, 'account_exists')).toBe('fail');
    expect(out.checks.slice(1).every((c) => c.status === 'unknown')).toBe(true);
    expect(out.recentHarvest).toBeNull();
    expect(out.summary).toMatch(/not active/);
    expect(server.requests.some((u) => u.pathname === '/statements/transaction')).toBe(false);
    expect(delegationDiagnoseTool.outputSchema.safeParse(out).success).toBe(true);
  });

  it('keeps the other checks when /node/unlockedaccount fails', async () => {
    server = await startTestServer({
      routes: routes({
        'GET /node/unlockedaccount': () => jsonResponse({ code: 'Internal', message: 'boom' }, 500),
      }),
    });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('cannot_verify');
    expect(statusOf(out, 'unlocked_on_node')).toBe('unknown');
    expect(statusOf(out, 'node_key_matches_configured_node')).toBe('ok');
    expect(statusOf(out, 'recent_harvest')).toBe('ok');
    expect(out.node.unlockedCount).toBeNull();
  });

  it('warns when no block was harvested recently but everything else is ok', async () => {
    server = await startTestServer({
      routes: routes({
        'GET /statements/transaction': { data: [], pagination: { pageNumber: 1, pageSize: 100 } },
      }),
    });
    const result = await server.callTool('symbol_delegation_diagnose', {
      account: ADDRESS,
      recentDays: 3,
    });
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('active');
    expect(out.checks.find((c) => c.id === 'recent_harvest')).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/No harvested block in the last 3 days/),
      hint: expect.stringMatching(/probabilistic/),
    });
    expect(out.recentHarvest).toEqual({ days: 3, receipts: 0, lastHeight: null, lastTime: null });
    const statements = server.requests.find((u) => u.pathname === '/statements/transaction');
    expect(statements?.searchParams.get('order')).toBe('desc');
    expect(statements?.searchParams.get('toHeight')).toBe('5763675');
  });

  describe('recent_harvest counts the blocks the account harvested', () => {
    // Shares on mainnet: harvester 70 %, beneficiary 25 %, network 5 % of 73,210,170 (the fee of
    // statement-harvest-one-block.json, where the main account is both harvester and beneficiary).
    const HARVESTER = '51247120';
    const BENEFICIARY = '18302542';
    const NETWORK = '3660508';
    const other = base32AddressToHex(publicKeyToAddress(H('fixture:harvest-peer-1'), 104));
    const sink = base32AddressToHex(publicKeyToAddress(H('fixture:harvest-peer-2'), 104));

    function statement(height: number, receipts: Array<[string, string]>) {
      return {
        statement: {
          height: String(height),
          source: { primaryId: 0, secondaryId: 0 },
          receipts: receipts.map(([targetAddress, amount]) => ({
            version: 1,
            type: 8515,
            targetAddress,
            mosaicId: XYM,
            amount,
          })),
        },
        id: H(`fixture:doc-id-diagnose-statement-${height}`).slice(0, 24),
        meta: { timestamp: String(173_192_454_149 + (height - 5_764_879) * 30_000) },
      };
    }
    /** A block the account harvested while also being its node's beneficiary: 2 receipts. */
    const ownBlock = (height: number) =>
      statement(height, [
        [MAIN_HEX, HARVESTER],
        [sink, NETWORK],
        [MAIN_HEX, BENEFICIARY],
      ]);
    /** A delegator's block that paid the account only the beneficiary share. */
    const beneficiaryOnlyBlock = (height: number) =>
      statement(height, [
        [other, HARVESTER],
        [MAIN_HEX, BENEFICIARY],
        [sink, NETWORK],
      ]);
    /** Both shares to the account, but split 60 / 35 / 5: matches no share pattern. */
    const unrecognisedBlock = (height: number) =>
      statement(height, [
        [MAIN_HEX, '43926102'],
        [MAIN_HEX, '25623560'],
        [sink, NETWORK],
      ]);
    const page = (...data: unknown[]) => ({ data, pagination: { pageNumber: 1, pageSize: 100 } });

    async function diagnose(data: unknown[]): Promise<Output> {
      server = await startTestServer({
        routes: routes({ 'GET /statements/transaction': page(...data) }),
      });
      const result = await server.callTool('symbol_delegation_diagnose', {
        account: ADDRESS,
        format: 'detailed',
      });
      expect(result.isError).toBe(false);
      const out = result.structuredContent as unknown as Output;
      expect(delegationDiagnoseTool.outputSchema.safeParse(out).success).toBe(true);
      return out;
    }
    const recentCheck = (out: Output) => out.checks.find((c) => c.id === 'recent_harvest');

    it('counts a block the account harvested as its own beneficiary once', async () => {
      const out = await diagnose([ownBlock(5_763_600), ownBlock(5_763_500)]);
      expect(out.recentHarvest).toMatchObject({ receipts: 2, lastHeight: 5_763_600 });
      expect(recentCheck(out)).toMatchObject({
        status: 'ok',
        detail: expect.stringMatching(
          /^Harvested 2 blocks in the last 7 days; newest at height 5,763,600 \(.*\)\.$/,
        ),
        hint: expect.stringMatching(/one per block it harvested/),
      });
      expect(out.summary).toMatch(/^- harvested 2 blocks in the last 7 days;/m);
    });

    it('does not count a block that paid the account only the beneficiary share', async () => {
      const out = await diagnose([beneficiaryOnlyBlock(5_763_600)]);
      expect(out.recentHarvest).toMatchObject({ receipts: 0, lastHeight: null, lastTime: null });
      expect(recentCheck(out)?.status).toBe('warn');
      expect(out.verdict).toBe('active');
    });

    it('leaves unrecognised blocks out of the count and names them in the detail', async () => {
      // The unrecognised block is the newest; lastHeight stays at the harvested one.
      const out = await diagnose([
        unrecognisedBlock(5_763_650),
        beneficiaryOnlyBlock(5_763_620),
        ownBlock(5_763_600),
      ]);
      expect(out.recentHarvest).toMatchObject({ receipts: 1, lastHeight: 5_763_600 });
      expect(recentCheck(out)).toMatchObject({
        status: 'ok',
        detail: expect.stringMatching(
          /^Harvested 1 block in the last 7 days; newest at height 5,763,600 \(.*\)\. Not counted: 1 block in which the account received harvest fees with a share split that was not recognised\.$/,
        ),
      });
      expect(out.verdict).toBe('active');
    });

    it('answers unknown, not ok, when the only blocks were not recognised', async () => {
      const out = await diagnose([unrecognisedBlock(5_763_650), unrecognisedBlock(5_763_640)]);
      expect(out.recentHarvest).toMatchObject({ receipts: 0, lastHeight: null, lastTime: null });
      expect(recentCheck(out)).toMatchObject({
        status: 'unknown',
        detail: expect.stringMatching(
          /^No block recognised as harvested by the account in the last 7 days \(heights .* to 5,763,675\), but there are 2 blocks in which the account received harvest fees with a share split that was not recognised\.$/,
        ),
        hint: expect.stringMatching(
          /harvestBeneficiaryPercentage \(25%\) and harvestNetworkPercentage \(5%\).*symbol_harvesting_income lists these receipts as unknown/,
        ),
      });
      // Nothing else fails, so the unknown check makes the verdict cannot_verify.
      expect(out.checks.filter((c) => c.status === 'fail')).toEqual([]);
      expect(out.verdict).toBe('cannot_verify');
      expect(out.summary.split('\n')[0]).toBe(`delegated harvesting: cannot verify (${ADDRESS}).`);
      expect(out.summary).toMatch(/^- could not verify: recent_harvest\.$/m);
      expect(out.summary).not.toMatch(/- harvested/);
    });

    it('describes a truncated window as a lower bound over statements', async () => {
      const full = Array.from({ length: 100 }, (_, i) => ownBlock(5_763_600 - i));
      const out = await diagnose(full);
      // The fake node answers every page with the same 100 rows, so the 20-page limit is reached.
      expect(out.notes).toContain(
        'recentHarvest reads only the newest 2,000 statements of the window (blocks in which the account received a harvest fee, as harvester or as beneficiary), so its count is a lower bound.',
      );
    });
  });

  it('treats the unknown node key case as unknown when /node/info has no nodePublicKey', async () => {
    const info = fixture<Record<string, unknown>>('mainnet/node-info.json');
    delete info.nodePublicKey;
    server = await startTestServer({ routes: routes({ 'GET /node/info': info }) });
    const result = await server.callTool('symbol_delegation_diagnose', { account: ADDRESS });
    const out = result.structuredContent as unknown as Output;
    expect(out.verdict).toBe('cannot_verify');
    expect(statusOf(out, 'node_key_matches_configured_node')).toBe('unknown');
    expect(statusOf(out, 'unlocked_on_node')).toBe('unknown');
    expect(out.node.configuredNodePublicKey).toBeNull();
  });

  it('rejects bad input with a hint', async () => {
    server = await startTestServer();
    const invalid = await server.callTool('symbol_delegation_diagnose', { account: 'Bogus!' });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/not a valid Symbol account identifier/);
    const tooLong = await server.callTool('symbol_delegation_diagnose', {
      account: ADDRESS,
      recentDays: 31,
    });
    expect(tooLong.isError).toBe(true);
    const tooShort = await server.callTool('symbol_delegation_diagnose', {
      account: ADDRESS,
      recentDays: 0,
    });
    expect(tooShort.isError).toBe(true);
  });
});
