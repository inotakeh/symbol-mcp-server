/**
 * Finalization proof participation (pure; no I/O).
 *
 * `GET /finalization/proof/epoch/{epoch}` (symbol-openapi FinalizationProofDTO) carries the
 * MessageGroups of the finalized point; each group lists the BM-tree signatures of the voters
 * that signed one message. Usually there is one group per stage, but a stage can be split into
 * several groups, even at the same height, when voters signed different hash lists (seen on the
 * mainnet proof of epoch 4027: one precommit group, two prevote groups with 2 and 15 signatures).
 * `signatures[].root.parentPublicKey` is the voter's registered voting public key
 * (`supplementalPublicKeys.voting.publicKeys[].publicKey`), as confirmed on a mainnet proof
 * (2026-09-13); `bottom.parentPublicKey` is an intermediate key and is never matched.
 *
 * Participation is judged per STAGE, never per group: a stage is signed when one of the
 * account's keys is among the root signers of any of its groups, and an account took part in an
 * epoch when every stage present in the proof is signed.
 *
 * Stage numbers: symbol-openapi v1.0.4 `StageEnum` (0 = Prevote, 1 = Precommit, 2 = Count).
 */
import type { VotingKeyInput } from './voting.js';

export const STAGE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'prevote'],
  [1, 'precommit'],
  [2, 'count'],
]);

export function stageName(stage: number): string {
  return STAGE_NAMES.get(stage) ?? `stage_${stage}`;
}

export interface ProofMessageGroupInput {
  readonly stage: number;
  readonly height: number;
  /** `signatures[].root.parentPublicKey` of the group: the voting keys that signed it. */
  readonly rootPublicKeys: readonly string[];
}

export interface ProofInput {
  readonly finalizationEpoch: number;
  readonly finalizationPoint: number;
  readonly height: number;
  readonly hash: string;
  readonly messageGroups: readonly ProofMessageGroupInput[];
}

export type EpochParticipationStatus = 'participated' | 'missed' | 'no_active_key' | 'unavailable';

/** One entry per stage, whatever the number of message groups the proof splits it into. */
export interface StageParticipation {
  readonly stage: number;
  readonly stageName: string;
  /** Lowest height among the stage's groups (the only one when there is a single group). */
  readonly height: number;
  /** Distinct heights of the stage's groups, ascending. */
  readonly heights: readonly number[];
  /** Number of message groups of this stage in the proof. */
  readonly groups: number;
  /** Signatures in all groups of the stage together. */
  readonly signatureCount: number;
  /** One of the account's keys is among the root signers of at least one group of the stage. */
  readonly participated: boolean;
  readonly matchedPublicKey: string | null;
}

export interface EpochParticipation {
  readonly epoch: number;
  readonly status: EpochParticipationStatus;
  readonly finalizationPoint: number | null;
  readonly height: number | null;
  readonly proofHash: string | null;
  /** Ascending by stage (prevote before precommit); empty when the proof is unavailable. */
  readonly stages: readonly StageParticipation[];
  readonly participatedAllStages: boolean;
}

export interface ParticipationTotals {
  readonly checked: number;
  readonly participated: number;
  readonly missed: number;
  readonly noActiveKey: number;
  readonly unavailable: number;
}

/** A registered key {startEpoch, endEpoch} may vote in epochs startEpoch..endEpoch inclusive. */
export function isKeyActiveForEpoch(key: VotingKeyInput, epoch: number): boolean {
  return key.startEpoch <= epoch && epoch <= key.endEpoch;
}

/** epoch, epoch-1, ... for `count` entries, never below epoch 1. */
export function expandEpochRange(epoch: number, count: number): number[] {
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('epoch must be a positive integer');
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const out: number[] = [];
  for (let e = epoch; e >= 1 && out.length < count; e--) out.push(e);
  return out;
}

/**
 * Judges one epoch. Registration data is the account's current key list while the proof is
 * historical, so a signature found in the proof outranks the key list: `participated` needs a
 * registered key among the root signers of every stage present in the proof (in any message
 * group of that stage); otherwise `no_active_key` when no registered key covers the epoch, else
 * `missed`.
 */
export function evaluateEpochParticipation(
  epoch: number,
  keys: readonly VotingKeyInput[],
  proof: ProofInput | null,
): EpochParticipation {
  if (!proof) {
    return {
      epoch,
      status: 'unavailable',
      finalizationPoint: null,
      height: null,
      proofHash: null,
      stages: [],
      participatedAllStages: false,
    };
  }
  const registered = keys.map((k) => k.publicKey.toUpperCase());
  const byStage = new Map<number, ProofMessageGroupInput[]>();
  for (const group of proof.messageGroups) {
    const groups = byStage.get(group.stage);
    if (groups) groups.push(group);
    else byStage.set(group.stage, [group]);
  }
  const stages: StageParticipation[] = [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, groups]) => {
      // Union over the groups: which group carries the key only says which hashes it voted for.
      const signers = new Set(groups.flatMap((g) => g.rootPublicKeys.map((k) => k.toUpperCase())));
      const matched = registered.find((k) => signers.has(k)) ?? null;
      const heights = [...new Set(groups.map((g) => g.height))].sort((a, b) => a - b);
      return {
        stage,
        stageName: stageName(stage),
        height: heights[0] ?? 0,
        heights,
        groups: groups.length,
        signatureCount: groups.reduce((n, g) => n + g.rootPublicKeys.length, 0),
        participated: matched !== null,
        matchedPublicKey: matched,
      };
    });
  const participatedAllStages = stages.length > 0 && stages.every((s) => s.participated);
  const hasActiveKey = keys.some((k) => isKeyActiveForEpoch(k, epoch));
  const status: EpochParticipationStatus = participatedAllStages
    ? 'participated'
    : hasActiveKey
      ? 'missed'
      : 'no_active_key';
  return {
    epoch,
    status,
    finalizationPoint: proof.finalizationPoint,
    height: proof.height,
    proofHash: proof.hash.toUpperCase(),
    stages,
    participatedAllStages,
  };
}

function joinWithAnd(names: readonly string[]): string {
  return names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The stages an account signed and, when it missed any, the ones it did not, for summaries:
 * "signed prevote and precommit" / "signed prevote, not precommit" /
 * "signed no stage (not prevote, not precommit)". Stages are named once each, so the text cannot
 * contradict itself however many message groups a stage has.
 */
export function describeSignedStages(
  stages: ReadonlyArray<{ readonly stageName: string; readonly participated: boolean }>,
): string {
  const signed = stages.filter((s) => s.participated).map((s) => s.stageName);
  const unsigned = stages.filter((s) => !s.participated).map((s) => `not ${s.stageName}`);
  if (stages.length === 0) return 'the proof lists no stage';
  if (unsigned.length === 0) return `signed ${joinWithAnd(signed)}`;
  if (signed.length === 0) return `signed no stage (${unsigned.join(', ')})`;
  return `signed ${joinWithAnd(signed)}, ${unsigned.join(', ')}`;
}

export function totalsOf(results: readonly EpochParticipation[]): ParticipationTotals {
  const count = (status: EpochParticipationStatus) =>
    results.filter((r) => r.status === status).length;
  return {
    checked: results.length,
    participated: count('participated'),
    missed: count('missed'),
    noActiveKey: count('no_active_key'),
    unavailable: count('unavailable'),
  };
}

/**
 * Warning about the account's ability to vote NOW, judged against the current finalization
 * epoch. Historical epochs never warn: a key that did not exist yet, or a vote missed long ago,
 * is visible in the per-epoch status only.
 * - No registered key covers `currentEpoch` (whatever epochs were requested): cannot vote.
 * - The most recent requested epoch is `currentEpoch` and it was missed: registered, not voting.
 */
export function participationWarning(
  results: readonly EpochParticipation[],
  keys: readonly VotingKeyInput[],
  currentEpoch: number,
): string | null {
  if (!keys.some((k) => isKeyActiveForEpoch(k, currentEpoch))) {
    return `No registered voting key of this account covers the current finalization epoch ${currentEpoch}; the account cannot take part in finalization until a key whose start/end epochs include it is linked (symbol_voting_key_status shows free slots and key lifetimes).`;
  }
  const latest = results[0];
  if (!latest || latest.epoch !== currentEpoch || latest.status !== 'missed') return null;
  const missed = latest.stages.filter((s) => !s.participated).map((s) => s.stageName);
  const what =
    missed.length === latest.stages.length
      ? 'any stage'
      : `the ${missed.join(' and ')} stage${missed.length === 1 ? '' : 's'}`;
  return `The account's voting key did not sign ${what} of the finalization proof for epoch ${currentEpoch}, the current finalization epoch. Check that the voting node is running, in sync, and configured with this voting key.`;
}
