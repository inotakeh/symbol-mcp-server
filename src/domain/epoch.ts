/**
 * Finalization epoch <-> block height conversion.
 *
 * With G = chain.votingSetGrouping (1440 on mainnet):
 *   epoch e covers heights (e-2)*G + 1 .. (e-1)*G   (for e >= 2; epoch 1 is the nemesis block)
 *   epoch of height h = floor((h-1)/G) + 2
 *
 * Verified against mainnet: finalized height 5,755,504 -> epoch 3998; 5,763,316 -> epoch 4004.
 */

function assertGrouping(grouping: number): void {
  if (!Number.isInteger(grouping) || grouping <= 0) {
    throw new Error('votingSetGrouping must be a positive integer');
  }
}

export function heightToEpoch(height: number, grouping: number): number {
  assertGrouping(grouping);
  if (!Number.isInteger(height) || height < 1) throw new Error('height must be a positive integer');
  if (height === 1) return 1;
  return Math.floor((height - 1) / grouping) + 2;
}

/** First height of an epoch. Epoch 1 is height 1 (nemesis), so epoch 2 starts at height 2. */
export function epochStartHeight(epoch: number, grouping: number): number {
  assertGrouping(grouping);
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('epoch must be a positive integer');
  if (epoch === 1) return 1;
  if (epoch === 2) return 2;
  return (epoch - 2) * grouping + 1;
}

/** Last height of an epoch. */
export function epochEndHeight(epoch: number, grouping: number): number {
  assertGrouping(grouping);
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('epoch must be a positive integer');
  if (epoch === 1) return 1;
  return (epoch - 1) * grouping;
}

/** A voting key with endEpoch E stops being usable after height (E-1)*G. */
export function votingKeyExpiryHeight(endEpoch: number, grouping: number): number {
  return epochEndHeight(endEpoch, grouping);
}

/** Parses a REST uint64 string height into a safe JS number. */
export function parseHeight(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid height: ${value}`);
  return n;
}
