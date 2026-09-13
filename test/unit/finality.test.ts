import { describe, expect, it } from 'vitest';
import {
  evaluateEpochParticipation,
  expandEpochRange,
  isKeyActiveForEpoch,
  type ProofInput,
  participationWarning,
  stageName,
  totalsOf,
} from '../../src/domain/finality.js';

const KEY_A = 'A'.repeat(64);
const KEY_B = 'B'.repeat(64);
const OTHER_1 = '1'.repeat(64);
const OTHER_2 = '2'.repeat(64);

const activeKey = { publicKey: KEY_A, startEpoch: 3700, endEpoch: 4059 };
const expiredKey = { publicKey: KEY_B, startEpoch: 3340, endEpoch: 3699 };

function proof(prevoteSigners: string[], precommitSigners: string[]): ProofInput {
  return {
    finalizationEpoch: 4010,
    finalizationPoint: 69,
    height: 5_772_912,
    hash: 'c'.repeat(64),
    // Proof order is precommit first, as catapult-rest returns it.
    messageGroups: [
      { stage: 1, height: 5_772_912, rootPublicKeys: precommitSigners },
      { stage: 0, height: 5_772_892, rootPublicKeys: prevoteSigners },
    ],
  };
}

describe('expandEpochRange', () => {
  it('counts back from the epoch and stops at epoch 1', () => {
    expect(expandEpochRange(4010, 1)).toEqual([4010]);
    expect(expandEpochRange(3, 3)).toEqual([3, 2, 1]);
    expect(expandEpochRange(2, 5)).toEqual([2, 1]);
    expect(expandEpochRange(4010, 3)).toEqual([4010, 4009, 4008]);
  });
  it('rejects non-positive input', () => {
    expect(() => expandEpochRange(0, 1)).toThrow(/epoch/);
    expect(() => expandEpochRange(5, 0)).toThrow(/count/);
    expect(() => expandEpochRange(5.5, 1)).toThrow(/epoch/);
  });
});

describe('isKeyActiveForEpoch', () => {
  it('is inclusive at both ends', () => {
    expect(isKeyActiveForEpoch(activeKey, 3699)).toBe(false);
    expect(isKeyActiveForEpoch(activeKey, 3700)).toBe(true);
    expect(isKeyActiveForEpoch(activeKey, 4059)).toBe(true);
    expect(isKeyActiveForEpoch(activeKey, 4060)).toBe(false);
  });
});

describe('stageName', () => {
  it('follows the OpenAPI StageEnum', () => {
    expect(stageName(0)).toBe('prevote');
    expect(stageName(1)).toBe('precommit');
    expect(stageName(2)).toBe('count');
    expect(stageName(7)).toBe('stage_7');
  });
});

describe('evaluateEpochParticipation', () => {
  it('reports participated when a registered key signed both stages, stages sorted ascending', () => {
    const r = evaluateEpochParticipation(
      4010,
      [expiredKey, activeKey],
      proof([OTHER_1, KEY_A, OTHER_2], [KEY_A, OTHER_1, OTHER_2]),
    );
    expect(r.status).toBe('participated');
    expect(r.participatedAllStages).toBe(true);
    expect(r.finalizationPoint).toBe(69);
    expect(r.height).toBe(5_772_912);
    expect(r.proofHash).toBe('C'.repeat(64));
    expect(r.stages.map((s) => [s.stage, s.stageName, s.height])).toEqual([
      [0, 'prevote', 5_772_892],
      [1, 'precommit', 5_772_912],
    ]);
    for (const s of r.stages) {
      expect(s.signatureCount).toBe(3);
      expect(s.participated).toBe(true);
      expect(s.matchedPublicKey).toBe(KEY_A);
    }
  });

  it('matches keys case-insensitively', () => {
    const r = evaluateEpochParticipation(
      4010,
      [{ ...activeKey, publicKey: KEY_A.toLowerCase() }],
      proof([KEY_A.toLowerCase()], [KEY_A]),
    );
    expect(r.status).toBe('participated');
    expect(r.stages[0]?.matchedPublicKey).toBe(KEY_A);
  });

  it('reports missed when only the prevote was signed', () => {
    const r = evaluateEpochParticipation(4010, [activeKey], proof([KEY_A, OTHER_1], [OTHER_1]));
    expect(r.status).toBe('missed');
    expect(r.participatedAllStages).toBe(false);
    expect(r.stages.map((s) => [s.stageName, s.participated, s.matchedPublicKey])).toEqual([
      ['prevote', true, KEY_A],
      ['precommit', false, null],
    ]);
  });

  it('reports missed when an active key signed nothing', () => {
    const r = evaluateEpochParticipation(4010, [activeKey], proof([OTHER_1], [OTHER_1]));
    expect(r.status).toBe('missed');
    expect(r.stages.every((s) => !s.participated)).toBe(true);
  });

  it('reports no_active_key when no key is registered', () => {
    const r = evaluateEpochParticipation(4010, [], proof([OTHER_1], [OTHER_1]));
    expect(r.status).toBe('no_active_key');
    expect(r.stages).toHaveLength(2);
  });

  it('reports no_active_key when only keys outside the epoch are registered', () => {
    const r = evaluateEpochParticipation(4010, [expiredKey], proof([OTHER_1], [OTHER_1]));
    expect(r.status).toBe('no_active_key');
    const future = { publicKey: KEY_B, startEpoch: 4011, endEpoch: 4300 };
    expect(evaluateEpochParticipation(4010, [future], proof([OTHER_1], [OTHER_1])).status).toBe(
      'no_active_key',
    );
  });

  it('lets a signature in the proof outrank an outdated key list', () => {
    // The key that voted has since been unlinked: the proof is the evidence that counts.
    const r = evaluateEpochParticipation(4010, [expiredKey], proof([KEY_B], [KEY_B]));
    expect(r.status).toBe('participated');
  });

  it('reports unavailable when there is no proof', () => {
    const r = evaluateEpochParticipation(4009, [activeKey], null);
    expect(r).toEqual({
      epoch: 4009,
      status: 'unavailable',
      finalizationPoint: null,
      height: null,
      proofHash: null,
      stages: [],
      participatedAllStages: false,
    });
  });

  it('treats a proof without message groups as missed, never as participated', () => {
    const empty: ProofInput = { ...proof([], []), messageGroups: [] };
    expect(evaluateEpochParticipation(4010, [activeKey], empty).status).toBe('missed');
  });
});

describe('totalsOf and participationWarning', () => {
  const participated = evaluateEpochParticipation(4010, [activeKey], proof([KEY_A], [KEY_A]));
  const missedAll = evaluateEpochParticipation(4009, [activeKey], proof([OTHER_1], [OTHER_1]));
  const missedPrecommit = evaluateEpochParticipation(4008, [activeKey], proof([KEY_A], [OTHER_1]));
  const noKey = evaluateEpochParticipation(4007, [expiredKey], proof([OTHER_1], [OTHER_1]));
  const unavailable = evaluateEpochParticipation(4006, [activeKey], null);

  it('counts every status', () => {
    expect(totalsOf([participated, missedAll, missedPrecommit, noKey, unavailable])).toEqual({
      checked: 5,
      participated: 1,
      missed: 2,
      noActiveKey: 1,
      unavailable: 1,
    });
    expect(totalsOf([])).toEqual({
      checked: 0,
      participated: 0,
      missed: 0,
      noActiveKey: 0,
      unavailable: 0,
    });
  });

  it('warns when no registered key covers the current epoch, whatever was requested', () => {
    // Epoch 4100 is past activeKey's endEpoch 4059: the account cannot vote now, even though
    // the requested epoch 4010 was fine.
    expect(participationWarning([participated], [activeKey], 4100)).toMatch(
      /No registered voting key .* covers the current finalization epoch 4100/,
    );
    expect(participationWarning([noKey], [expiredKey], 4007)).toMatch(
      /covers the current finalization epoch 4007/,
    );
    expect(participationWarning([noKey], [expiredKey], 4007)).toMatch(/symbol_voting_key_status/);
    expect(participationWarning([], [], 4010)).toMatch(/current finalization epoch 4010/);
  });

  it('warns when the current epoch was requested and missed', () => {
    expect(participationWarning([missedAll, participated], [activeKey], 4009)).toMatch(
      /did not sign any stage of the finalization proof for epoch 4009, the current finalization epoch/,
    );
    expect(participationWarning([missedPrecommit], [activeKey], 4008)).toMatch(
      /did not sign the precommit stage of the finalization proof for epoch 4008/,
    );
  });

  it('stays null for missed or unavailable historical epochs and when nothing was checked', () => {
    // A vote missed in the past is visible in the per-epoch status only.
    expect(participationWarning([missedAll], [activeKey], 4010)).toBeNull();
    expect(participationWarning([missedPrecommit], [activeKey], 4010)).toBeNull();
    expect(participationWarning([participated, missedAll], [activeKey], 4010)).toBeNull();
    expect(participationWarning([participated], [activeKey], 4010)).toBeNull();
    expect(participationWarning([unavailable], [activeKey], 4006)).toBeNull();
    expect(participationWarning([unavailable, missedAll], [activeKey], 4006)).toBeNull();
    expect(participationWarning([], [activeKey], 4010)).toBeNull();
  });

  it('is null for a keyless historical epoch when the current key covers the current epoch', () => {
    // Epoch 5 predates every key of the account: normal, not a problem for voting today.
    const historical = evaluateEpochParticipation(5, [activeKey], proof([OTHER_1], [OTHER_1]));
    expect(historical.status).toBe('no_active_key');
    expect(participationWarning([historical], [activeKey], 4010)).toBeNull();
    expect(participationWarning([historical, participated], [activeKey], 4010)).toBeNull();
    expect(participationWarning([historical], [expiredKey, activeKey], 4059)).toBeNull();
  });
});
