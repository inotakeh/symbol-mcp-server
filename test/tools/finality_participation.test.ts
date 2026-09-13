/**
 * symbol_finality_participation against the synthetic mainnet proof for epoch 4010
 * (test/fixtures/mainnet/finalization-proof-epoch.json, see test/fixtures/README.md). The
 * account's active voting key (H("fixture:voting-key-2")) is root signer #01 in both stages; the
 * other 16 root keys are H("fixture:voter-02") ... H("fixture:voter-17").
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/server.js';
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

const H = (label: string) =>
  createHash('sha3-256').update(label, 'utf8').digest('hex').toUpperCase();

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';
const OWN_KEY = '534A99C9338ECD32AD8E8C3F38304D2A9477049601ECE134A11F36EB4D36D549';
const EXPIRED_KEY = 'C38F80FBE1388C1C9BF7E5EF4664DA3AF45D750D65230FBFCC42CEC6481E68FE';
const PROOF_EPOCH = 4010;
const PROOF_POINT = 69;
const PROOF_HEIGHT = 5_772_912;
const PREVOTE_HEIGHT = 5_772_892;
const SIGNATURES = 17;
const PROOF_PATH = `/finalization/proof/epoch/${PROOF_EPOCH}`;

type Proof = {
  finalizationEpoch: number;
  hash: string;
  messageGroups: Array<{
    stage: number;
    height: string;
    hashes: string[];
    signatures: Array<{ root: { parentPublicKey: string }; bottom: { parentPublicKey: string } }>;
  }>;
};
type Account = {
  account: {
    supplementalPublicKeys: {
      voting?: { publicKeys: Array<{ publicKey: string; startEpoch: number; endEpoch: number }> };
    };
  };
};
type EpochRow = {
  epoch: number;
  status: string;
  finalizationPoint: number | null;
  height: number | null;
  proofHash: string | null;
  stages?: Array<{
    stage: number;
    stageName: string;
    height: number;
    signatureCount: number;
    participated: boolean;
    matchedPublicKey: string | null;
  }>;
  participatedAllStages: boolean;
};

const proof = () => fixture<Proof>('mainnet/finalization-proof-epoch.json');

/** First epoch row of a successful call. */
function firstEpoch(result: { structuredContent: Record<string, unknown> | undefined }): EpochRow {
  const rows = result.structuredContent?.epochs as EpochRow[] | undefined;
  const row = rows?.[0];
  if (!row) throw new Error('no epoch rows in the result');
  return row;
}
const account = () => fixture<Account>('mainnet/account-voting.json');

function withVotingKeys(keys: Array<{ publicKey: string; startEpoch: number; endEpoch: number }>) {
  const acct = account();
  acct.account.supplementalPublicKeys.voting = { publicKeys: keys };
  return acct;
}

/** chain-info fixture with the latest finalized epoch moved to `finalizationEpoch`. */
function chainAt(finalizationEpoch: number) {
  const chain = fixture<{ latestFinalizedBlock: Record<string, unknown> }>(
    'mainnet/chain-info.json',
  );
  chain.latestFinalizedBlock = {
    ...chain.latestFinalizedBlock,
    finalizationEpoch,
    finalizationPoint: PROOF_POINT,
    height: String(PROOF_HEIGHT),
  };
  return chain;
}

function routes(extra: Routes = {}): Routes {
  return { ...mainnetRoutes(), ...extra };
}

describe('the synthetic proof fixture', () => {
  it('has the shape and counts of the real epoch 4010 proof, with synthetic keys', () => {
    const p = proof();
    expect(H('fixture:voting-key-2')).toBe(OWN_KEY);
    expect(p.finalizationEpoch).toBe(PROOF_EPOCH);
    expect(p.messageGroups.map((g) => g.stage)).toEqual([1, 0]);
    expect(p.messageGroups.map((g) => g.signatures.length)).toEqual([SIGNATURES, SIGNATURES]);
    expect(p.messageGroups[1]?.hashes).toHaveLength(21);
    expect(p.hash).toBe(H('fixture:proof-hash-21'));
    expect(p.messageGroups[0]?.hashes).toEqual([p.hash]);
    const voters = Array.from({ length: SIGNATURES - 1 }, (_, i) =>
      H(`fixture:voter-${String(i + 2).padStart(2, '0')}`),
    );
    // Root signers are numbered by their order in the stage 1 group; stage 0 lists the same
    // keys in the node's own order.
    const precommitRoots = p.messageGroups[0]?.signatures.map((s) => s.root.parentPublicKey);
    expect(precommitRoots).toEqual([OWN_KEY, ...voters]);
    for (const g of p.messageGroups) {
      const roots = g.signatures.map((s) => s.root.parentPublicKey);
      expect(new Set(roots)).toEqual(new Set([OWN_KEY, ...voters]));
      expect(g.signatures.map((s) => s.bottom.parentPublicKey)).not.toContain(OWN_KEY);
    }
  });
});

describe('symbol_finality_participation', () => {
  it('reports participation in both stages for the fixture account (detailed)', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
      format: 'detailed',
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      account: {
        address: string;
        votingKeys: Array<{ publicKey: string; activeForEpoch: boolean }>;
      };
      current: { finalizationEpoch: number };
      requested: { epoch: number; epochs: number };
      epochs: EpochRow[];
      totals: Record<string, number>;
      warning: string | null;
      notes: string[];
    };
    expect(sc.account.address).toBe(ADDRESS);
    expect(sc.account.votingKeys.map((k) => [k.publicKey, k.activeForEpoch])).toEqual([
      [EXPIRED_KEY, false],
      [OWN_KEY, true],
    ]);
    expect(sc.current.finalizationEpoch).toBe(4004);
    expect(sc.requested).toEqual({ epoch: PROOF_EPOCH, epochs: 1 });
    expect(sc.epochs).toHaveLength(1);
    const row = sc.epochs[0] as EpochRow;
    expect(row).toMatchObject({
      epoch: PROOF_EPOCH,
      status: 'participated',
      finalizationPoint: PROOF_POINT,
      height: PROOF_HEIGHT,
      proofHash: H('fixture:proof-hash-21'),
      participatedAllStages: true,
    });
    expect(row.stages).toEqual([
      {
        stage: 0,
        stageName: 'prevote',
        height: PREVOTE_HEIGHT,
        signatureCount: SIGNATURES,
        participated: true,
        matchedPublicKey: OWN_KEY,
      },
      {
        stage: 1,
        stageName: 'precommit',
        height: PROOF_HEIGHT,
        signatureCount: SIGNATURES,
        participated: true,
        matchedPublicKey: OWN_KEY,
      },
    ]);
    expect(sc.totals).toEqual({
      checked: 1,
      participated: 1,
      missed: 0,
      noActiveKey: 0,
      unavailable: 0,
    });
    expect(sc.warning).toBeNull();
    expect(sc.notes.length).toBeGreaterThanOrEqual(3);
    const summary = result.structuredContent?.summary as string;
    expect(summary).toMatch(/1 epoch checked \(epoch 4010; latest finalized epoch 4004\)/);
    expect(summary).toMatch(/1 participated, 0 missed, 0 without an active key, 0 unavailable/);
    expect(summary).toMatch(
      /Epoch 4010: participated \(prevote 17 signatures, precommit 17 signatures; proof at height 5,772,912, point 69\)/,
    );
    expect(summary).toMatch(
      /Voting keys: 2 registered, 1 covers epoch 4010 \(534A99C9… epochs 3700-4059\)/,
    );
    expect(summary).not.toContain(H('fixture:voter-02'));
    expect(JSON.stringify(result.structuredContent)).not.toContain(H('fixture:voter-02'));
    const paths = server.requests.map((u) => u.pathname);
    expect(paths).toContain(`/accounts/${ADDRESS}`);
    expect(paths).toContain('/chain/info');
    expect(paths).toContain(PROOF_PATH);
    expect(new Set(server.requests.map((u) => u.host))).toEqual(new Set([TEST_NODE_HOST]));
  });

  it('omits stages for participated epochs in concise format', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(false);
    const row = firstEpoch(result);
    expect(row.status).toBe('participated');
    expect(row.stages).toBeUndefined();
  });

  it('defaults to the latest finalized epoch from /chain/info', async () => {
    server = await startTestServer({ routes: routes({ 'GET /chain/info': chainAt(PROOF_EPOCH) }) });
    const result = await server.callTool('symbol_finality_participation', { account: ADDRESS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.requested).toEqual({ epoch: PROOF_EPOCH, epochs: 1 });
    expect(firstEpoch(result).status).toBe('participated');
    expect(server.requests.map((u) => u.pathname)).toContain(PROOF_PATH);
  });

  it('reports missed when the registered key signed neither stage of the current epoch, with a warning', async () => {
    const stranger = H('fixture:voting-key-3');
    server = await startTestServer({
      routes: routes({
        'GET /chain/info': chainAt(PROOF_EPOCH),
        [`GET /accounts/${ADDRESS}`]: withVotingKeys([
          { publicKey: stranger, startEpoch: 3700, endEpoch: 4059 },
        ]),
      }),
    });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(false);
    const row = firstEpoch(result);
    expect(row.status).toBe('missed');
    expect(row.participatedAllStages).toBe(false);
    expect(row.stages?.map((s) => [s.stageName, s.participated, s.matchedPublicKey])).toEqual([
      ['prevote', false, null],
      ['precommit', false, null],
    ]);
    expect(result.structuredContent?.warning).toMatch(
      /did not sign any stage of the finalization proof for epoch 4010, the current finalization epoch/,
    );
    expect(result.structuredContent?.summary).toMatch(
      /Epoch 4010: MISSED, the account's key signed neither stage/,
    );
    expect(result.structuredContent?.summary).toMatch(/Warning: /);
  });

  it('keeps a missed historical epoch in the status without a warning', async () => {
    // Latest finalized epoch is 4004 (fixture); 4010 is requested explicitly, so it is not
    // "now" for warning purposes even though the fixture proof exists for it.
    const stranger = H('fixture:voting-key-3');
    server = await startTestServer({
      routes: routes({
        [`GET /accounts/${ADDRESS}`]: withVotingKeys([
          { publicKey: stranger, startEpoch: 3700, endEpoch: 4059 },
        ]),
      }),
    });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(false);
    expect(firstEpoch(result).status).toBe('missed');
    expect(result.structuredContent?.warning).toBeNull();
    expect(result.structuredContent?.summary).not.toMatch(/Warning: /);
  });

  it('reports missed with stage detail when only the prevote was signed', async () => {
    const p = proof();
    const precommit = p.messageGroups.find((g) => g.stage === 1);
    if (!precommit) throw new Error('fixture has no precommit group');
    for (const s of precommit.signatures) {
      if (s.root.parentPublicKey === OWN_KEY) s.root.parentPublicKey = H('fixture:voter-99');
    }
    server = await startTestServer({
      routes: routes({ 'GET /chain/info': chainAt(PROOF_EPOCH), [`GET ${PROOF_PATH}`]: p }),
    });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(false);
    const row = firstEpoch(result);
    expect(row.status).toBe('missed');
    expect(row.stages?.map((s) => [s.stageName, s.participated])).toEqual([
      ['prevote', true],
      ['precommit', false],
    ]);
    expect(result.structuredContent?.summary).toMatch(
      /Epoch 4010: MISSED, signed prevote only, not precommit/,
    );
    expect(result.structuredContent?.warning).toMatch(/did not sign the precommit stage/);
  });

  it('reports no_active_key when no registered key covers the epoch', async () => {
    server = await startTestServer({
      routes: routes({
        [`GET /accounts/${ADDRESS}`]: withVotingKeys([
          { publicKey: EXPIRED_KEY, startEpoch: 3340, endEpoch: 3699 },
        ]),
      }),
    });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      account: { votingKeys: Array<{ activeForEpoch: boolean }> };
      epochs: EpochRow[];
      warning: string;
      summary: string;
    };
    expect(sc.epochs[0]?.status).toBe('no_active_key');
    expect(sc.account.votingKeys.map((k) => k.activeForEpoch)).toEqual([false]);
    // The only key ended at 3699, so the current epoch (4004 in the fixture) is uncovered too.
    expect(sc.warning).toMatch(
      /No registered voting key .* covers the current finalization epoch 4004/,
    );
    expect(sc.summary).toMatch(/Voting keys: 1 registered, 0 cover epoch 4010\./);
    expect(sc.summary).toMatch(/Epoch 4010: no registered voting key covers this epoch/);
  });

  it('does not warn about a keyless historical epoch when a key covers the current epoch', async () => {
    // A key that covers the current epoch 4004 but ended before 4010: 4010 is no_active_key
    // as a fact about the past, and there is nothing to fix today.
    server = await startTestServer({
      routes: routes({
        [`GET /accounts/${ADDRESS}`]: withVotingKeys([
          { publicKey: H('fixture:voting-key-3'), startEpoch: 3700, endEpoch: 4005 },
        ]),
      }),
    });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(false);
    expect(firstEpoch(result).status).toBe('no_active_key');
    expect(result.structuredContent?.warning).toBeNull();
    expect(result.structuredContent?.summary).not.toMatch(/Warning: /);
  });

  it('marks epochs whose proof the node lacks as unavailable without failing', async () => {
    server = await startTestServer();
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
      epochs: 3,
    });
    expect(result.isError).toBe(false);
    const rows = result.structuredContent?.epochs as EpochRow[];
    expect(rows.map((r) => [r.epoch, r.status])).toEqual([
      [4010, 'participated'],
      [4009, 'unavailable'],
      [4008, 'unavailable'],
    ]);
    expect(rows[1]).toMatchObject({
      finalizationPoint: null,
      height: null,
      proofHash: null,
      stages: [],
      participatedAllStages: false,
    });
    expect(result.structuredContent?.totals).toEqual({
      checked: 3,
      participated: 1,
      missed: 0,
      noActiveKey: 0,
      unavailable: 2,
    });
    expect(result.structuredContent?.warning).toBeNull();
    expect(result.structuredContent?.summary).toMatch(/epochs 4010 down to 4008/);
    expect(result.structuredContent?.summary).toMatch(/Epoch 4009: proof not available/);
    const paths = server.requests.map((u) => u.pathname);
    for (const e of [4010, 4009, 4008]) expect(paths).toContain(`/finalization/proof/epoch/${e}`);
  });

  it('is an error with a hint when no requested epoch has a proof', async () => {
    server = await startTestServer();
    const old = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: 4000,
      epochs: 2,
    });
    expect(old.isError).toBe(true);
    expect(old.text).toMatch(/No finalization proof for epochs 4000 down to 3999/);
    expect(old.text).toMatch(/limited history/);
    expect(old.text).toMatch(/latest finalized epoch \(4004\)/);

    const future = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: 4020,
    });
    expect(future.isError).toBe(true);
    expect(future.text).toMatch(/epoch 4020 is above the latest finalized epoch 4004/);
  });

  it('rejects a proof whose epoch does not match the request', async () => {
    const p = proof();
    p.finalizationEpoch = 4009;
    server = await startTestServer({ routes: routes({ [`GET ${PROOF_PATH}`]: p }) });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unexpected response shape/);
  });

  it('rejects an invalid account and an out-of-range epochs value', async () => {
    server = await startTestServer();
    const bad = await server.callTool('symbol_finality_participation', { account: 'Nope!' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not a valid Symbol account identifier/);
    // Schema bounds (1..20) are enforced by the SDK before the tool runs.
    for (const epochs of [21, 0]) {
      const out = await server.callTool('symbol_finality_participation', {
        account: ADDRESS,
        epochs,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Input validation error/);
      expect(out.text).toMatch(/epochs/);
    }
    expect(server.requests.filter((u) => u.pathname.startsWith('/finalization/'))).toHaveLength(0);
  });

  it('answers a proof served with a 404 body shape and validates its output schema', async () => {
    server = await startTestServer({
      routes: routes({
        [`GET ${PROOF_PATH}`]: () => jsonResponse({ code: 'ResourceNotFound' }, 404),
      }),
    });
    const result = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
      epochs: 2,
    });
    expect(result.isError).toBe(true);
    const def = TOOLS.find((t) => t.name === 'symbol_finality_participation');
    expect(def).toBeDefined();
    server = await startTestServer();
    const ok = await server.callTool('symbol_finality_participation', {
      account: ADDRESS,
      epoch: PROOF_EPOCH,
      epochs: 2,
      format: 'detailed',
    });
    expect(def?.outputSchema.safeParse(ok.structuredContent).success).toBe(true);
  });
});
