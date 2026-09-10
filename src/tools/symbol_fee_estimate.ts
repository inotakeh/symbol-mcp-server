import * as z from 'zod/v4';
import { TransactionFeesSchema } from '../client/schemas.js';
import { DEFAULT_TRANSFER_SIZE_BYTES, estimateFees } from '../domain/fee.js';
import { defineTool } from './_shared.js';

/** catapult rejects transactions above maxTransactionSize; 1 MiB is a safe upper bound. */
const MAX_SIZE_BYTES = 1_048_576;

const inputSchema = z.object({
  transactionSizeBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_SIZE_BYTES)
    .optional()
    .describe(
      `Serialized transaction size in bytes. Omit to use a representative transfer (1 mosaic, 20-character message = ${DEFAULT_TRANSFER_SIZE_BYTES} bytes). A transfer with no message is 176 bytes; add 16 per extra mosaic and 1 per message character.`,
    ),
});

const TierSchema = z.object({
  multiplier: z.number(),
  rawFee: z.string(),
  fee: z.string(),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  currency: z.string(),
  sizeBytes: z.number(),
  sizeAssumption: z.string(),
  tiers: z.object({
    slow: TierSchema,
    average: TierSchema,
    median: TierSchema,
    fast: TierSchema,
  }),
  multipliers: z.object({
    minFeeMultiplier: z.number(),
    averageFeeMultiplier: z.number(),
    medianFeeMultiplier: z.number(),
    highestFeeMultiplier: z.number(),
    lowestFeeMultiplier: z.number(),
  }),
  note: z.string(),
});

export const feeEstimateTool = defineTool({
  name: 'symbol_fee_estimate',
  title: 'Symbol fee estimate',
  description:
    'Estimate the fee for a Symbol transaction of a given size from the current fee multipliers of the configured node (fee = size in bytes x multiplier). Returns slow (minimum accepted by this node), average, median and fast (highest recent) tiers in XYM and raw units. Nothing is signed or sent.',
  inputSchema,
  outputSchema,
  run: async (ctx, { transactionSizeBytes }) => {
    const [fees, { currency }] = await Promise.all([
      ctx.rest.get('/network/fees/transaction', TransactionFeesSchema),
      ctx.getNetworkData(),
    ]);
    const sizeBytes = transactionSizeBytes ?? DEFAULT_TRANSFER_SIZE_BYTES;
    const sizeAssumption =
      transactionSizeBytes === undefined
        ? `Representative transfer: 128-byte header + 32-byte transfer body + 1 mosaic (16 bytes) + 20-character plain message (21 bytes) = ${DEFAULT_TRANSFER_SIZE_BYTES} bytes.`
        : `Size supplied by the caller: ${sizeBytes} bytes.`;
    const estimate = estimateFees(sizeBytes, fees, currency.divisibility);
    const label = currency.alias ?? currency.mosaicId;

    const summary = [
      `Fee estimate on ${ctx.network.name} for a ${sizeBytes}-byte transaction (multipliers from ${ctx.rest.host}):`,
      `slow ${estimate.slow.fee} ${label} (x${estimate.slow.multiplier}, this node's minimum), average ${estimate.average.fee} (x${estimate.average.multiplier}), median ${estimate.median.fee} (x${estimate.median.multiplier}), fast ${estimate.fast.fee} (x${estimate.fast.multiplier}).`,
      transactionSizeBytes === undefined
        ? `Size assumes a transfer with 1 mosaic and a 20-character message; pass transactionSizeBytes for other transactions. Nothing was sent.`
        : 'Nothing was sent.',
    ].join('\n');

    return {
      summary,
      network: ctx.network.name,
      currency: label,
      sizeBytes,
      sizeAssumption,
      tiers: {
        slow: estimate.slow,
        average: estimate.average,
        median: estimate.median,
        fast: estimate.fast,
      },
      multipliers: {
        minFeeMultiplier: fees.minFeeMultiplier,
        averageFeeMultiplier: fees.averageFeeMultiplier,
        medianFeeMultiplier: fees.medianFeeMultiplier,
        highestFeeMultiplier: fees.highestFeeMultiplier,
        lowestFeeMultiplier: fees.lowestFeeMultiplier,
      },
      note: 'A block includes a transaction only when its maxFee >= size x the block fee multiplier. Other nodes may enforce a different minimum multiplier; the fast tier is the highest multiplier seen in recent blocks.',
    };
  },
});
