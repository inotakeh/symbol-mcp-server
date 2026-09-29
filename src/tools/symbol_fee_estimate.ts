import * as z from 'zod/v4';
import { TransactionFeesSchema } from '../client/schemas.js';
import {
  DEFAULT_MESSAGE_BYTES,
  DEFAULT_MESSAGE_CHARACTERS,
  DEFAULT_TRANSFER_SIZE_BYTES,
  estimateFees,
  MESSAGE_TYPE_BYTES,
  MOSAIC_ENTRY_BYTES,
  TRANSACTION_HEADER_BYTES,
  TRANSFER_BODY_BYTES,
  transferSizeBytes,
} from '../domain/fee.js';
import { mosaicLabel } from '../domain/quote.js';
import { defineTool } from './_shared.js';

/** catapult rejects transactions above maxTransactionSize; 1 MiB is a safe upper bound. */
const MAX_SIZE_BYTES = 1_048_576;

/** A transfer without its mosaics and message: header and transfer body (160 bytes). */
const TRANSFER_FIXED_BYTES = TRANSACTION_HEADER_BYTES + TRANSFER_BODY_BYTES;
/** UTF-8 bytes of a 20-character Japanese message (3 per character), for the worked example. */
const JAPANESE_EXAMPLE_BYTES = DEFAULT_MESSAGE_CHARACTERS * 3;

const inputSchema = z.object({
  transactionSizeBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_SIZE_BYTES)
    .optional()
    .describe(
      `Serialized transaction size in bytes. Omit to use a representative transfer: 1 mosaic and a ${DEFAULT_MESSAGE_CHARACTERS}-character ASCII message = ${DEFAULT_TRANSFER_SIZE_BYTES} bytes. For a transfer, count ${TRANSFER_FIXED_BYTES} bytes, plus ${MOSAIC_ENTRY_BYTES} per mosaic, plus a plain message: ${MESSAGE_TYPE_BYTES} type byte and its text in UTF-8 bytes, not characters (1 per ASCII character, usually 3 per Japanese character). No message and 1 mosaic = ${transferSizeBytes(1, null)} bytes; a ${DEFAULT_MESSAGE_CHARACTERS}-character Japanese message and 1 mosaic = ${transferSizeBytes(1, JAPANESE_EXAMPLE_BYTES)} bytes. An encrypted message or a harvesting delegation request carries more than its text, so pass its serialized size. This count is not for aggregate transactions, whose size also includes their inner transactions and cosignatures.`,
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
  untrustedText: true,
  run: async (ctx, { transactionSizeBytes }, text) => {
    const [fees, { currency }] = await Promise.all([
      ctx.rest.get('/network/fees/transaction', TransactionFeesSchema),
      ctx.getNetworkData(),
    ]);
    const sizeBytes = transactionSizeBytes ?? DEFAULT_TRANSFER_SIZE_BYTES;
    const sizeAssumption =
      transactionSizeBytes === undefined
        ? `Representative transfer: ${TRANSACTION_HEADER_BYTES}-byte header + ${TRANSFER_BODY_BYTES}-byte transfer body + 1 mosaic (${MOSAIC_ENTRY_BYTES} bytes) + a ${DEFAULT_MESSAGE_CHARACTERS}-character ASCII message (${MESSAGE_TYPE_BYTES} type byte + ${DEFAULT_MESSAGE_CHARACTERS} UTF-8 bytes = ${DEFAULT_MESSAGE_BYTES} bytes) = ${DEFAULT_TRANSFER_SIZE_BYTES} bytes. A plain message counts in UTF-8 bytes, not characters (usually 3 per Japanese character).`
        : `Size supplied by the caller: ${sizeBytes} bytes, used as given.`;
    const estimate = estimateFees(sizeBytes, fees, currency.divisibility);
    const alias = text.useOrNull(currency.alias);
    const label = alias ?? currency.mosaicId;

    const summary = [
      `Fee estimate on ${ctx.network.name} for a ${sizeBytes}-byte transaction (multipliers from ${ctx.rest.host}):`,
      `slow ${estimate.slow.fee} ${mosaicLabel(alias, currency.mosaicId)} (x${estimate.slow.multiplier}, this node's minimum), average ${estimate.average.fee} (x${estimate.average.multiplier}), median ${estimate.median.fee} (x${estimate.median.multiplier}), fast ${estimate.fast.fee} (x${estimate.fast.multiplier}).`,
      transactionSizeBytes === undefined
        ? `Size assumes a transfer with 1 mosaic and a ${DEFAULT_MESSAGE_CHARACTERS}-character ASCII message. A plain message counts in UTF-8 bytes plus ${MESSAGE_TYPE_BYTES} type byte (a ${DEFAULT_MESSAGE_CHARACTERS}-character Japanese message makes ${transferSizeBytes(1, JAPANESE_EXAMPLE_BYTES)} bytes), so pass transactionSizeBytes for another message or transaction. Nothing was sent.`
        : 'Size as supplied by the caller, used as given. Nothing was sent.',
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
