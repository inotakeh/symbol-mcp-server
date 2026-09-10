/**
 * Fee estimation. A transaction pays `size (bytes) x feeMultiplier` raw currency units, and a
 * block includes a transaction only if its maxFee covers the block's multiplier. Nothing here
 * sends anything; the tool only multiplies published multipliers by a size.
 */
import { formatAmount } from './amount.js';

/**
 * Serialized size of a representative transfer, derived from the catbuffer schemas
 * (symbol/symbol catbuffer/schemas/symbol/transaction.cats and transfer/transfer.cats):
 *   header 128 bytes (size 4, reserved 4, signature 64, signer 32, reserved 4, version 1,
 *   network 1, type 2, maxFee 8, deadline 8)
 *   transfer body 32 bytes (recipient 24, message size 2, mosaic count 1, reserved 1 + 4)
 *   + 16 bytes per mosaic + message bytes (1 type byte + text).
 * The default assumes 1 mosaic and a 20-character plain message: 128 + 32 + 16 + 21 = 197.
 * The captured mainnet transfer with 1 mosaic and no message is 176 bytes, matching the formula.
 */
export const TRANSACTION_HEADER_BYTES = 128;
export const TRANSFER_BODY_BYTES = 32;
export const MOSAIC_ENTRY_BYTES = 16;
export const DEFAULT_MESSAGE_BYTES = 21;
export const DEFAULT_TRANSFER_SIZE_BYTES =
  TRANSACTION_HEADER_BYTES + TRANSFER_BODY_BYTES + MOSAIC_ENTRY_BYTES + DEFAULT_MESSAGE_BYTES;

export interface FeeMultipliers {
  readonly minFeeMultiplier: number;
  readonly averageFeeMultiplier: number;
  readonly medianFeeMultiplier: number;
  readonly highestFeeMultiplier: number;
}

export interface FeeTier {
  readonly multiplier: number;
  readonly rawFee: string;
  readonly fee: string;
}

export interface FeeEstimate {
  readonly sizeBytes: number;
  readonly slow: FeeTier;
  readonly average: FeeTier;
  readonly median: FeeTier;
  readonly fast: FeeTier;
}

function tier(sizeBytes: number, multiplier: number, divisibility: number): FeeTier {
  const raw = BigInt(sizeBytes) * BigInt(multiplier);
  return { multiplier, rawFee: raw.toString(), fee: formatAmount(raw, divisibility) };
}

export function estimateFees(
  sizeBytes: number,
  multipliers: FeeMultipliers,
  divisibility: number,
): FeeEstimate {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('sizeBytes must be a positive integer');
  }
  return {
    sizeBytes,
    slow: tier(sizeBytes, multipliers.minFeeMultiplier, divisibility),
    average: tier(sizeBytes, multipliers.averageFeeMultiplier, divisibility),
    median: tier(sizeBytes, multipliers.medianFeeMultiplier, divisibility),
    fast: tier(sizeBytes, multipliers.highestFeeMultiplier, divisibility),
  };
}
