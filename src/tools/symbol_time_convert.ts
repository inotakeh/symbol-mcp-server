import * as z from 'zod/v4';
import { BlockInfoSchema, ChainInfoSchema } from '../client/schemas.js';
import { epochEndHeight, epochStartHeight, heightToEpoch, parseHeight } from '../domain/epoch.js';
import {
  dateToNetworkTimestamp,
  estimateDateAtHeight,
  formatInstantText,
  networkTimestampToDate,
  roundTo,
} from '../domain/time.js';
import { defineTool, formatInteger, nullable, ToolInputError } from './_shared.js';
import { InstantSchema } from './_transactions.js';

const inputSchema = z
  .object({
    height: z.number().int().min(1).optional().describe('Block height to convert.'),
    epoch: z.number().int().min(1).optional().describe('Finalization epoch to convert.'),
    timestamp: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Network timestamp in milliseconds since the network epoch (as in block.timestamp).',
      ),
  })
  .refine((v) => [v.height, v.epoch, v.timestamp].filter((x) => x !== undefined).length === 1, {
    message: 'Pass exactly one of height, epoch or timestamp.',
  });

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  input: z.object({
    kind: z.enum(['height', 'epoch', 'timestamp']),
    value: z.number(),
  }),
  height: z.number(),
  epoch: z.number(),
  epochRange: z.object({ startHeight: z.number(), endHeight: z.number() }),
  networkTimestampMs: z.number(),
  time: InstantSchema,
  epochEnd: nullable(
    z.object({ height: z.number(), networkTimestampMs: z.number(), time: InstantSchema }),
    'End of the epoch (last block); only for epoch input.',
  ),
  isEstimate: z.boolean(),
  method: z.string(),
  current: z.object({
    height: z.number(),
    finalizationEpoch: z.number(),
    votingSetGrouping: z.number(),
    averageBlockTimeSeconds: z.number(),
  }),
});

export const timeConvertTool = defineTool({
  name: 'symbol_time_convert',
  title: 'Symbol time converter',
  description:
    'Convert between a Symbol block height, finalization epoch, network timestamp (milliseconds since the network epoch) and wall-clock time (UTC plus local time when SYMBOL_TIMEZONE is set). Pass exactly one of height, epoch or timestamp. Past heights use the real block time; future heights and epochs are estimated from the measured average block time and flagged isEstimate.',
  inputSchema,
  outputSchema,
  run: async (ctx, { height, epoch, timestamp }) => {
    const [chain, { properties }] = await Promise.all([
      ctx.rest.get('/chain/info', ChainInfoSchema),
      ctx.getNetworkData(),
    ]);
    const currentHeight = parseHeight(chain.height);
    const G = properties.votingSetGrouping;
    const epochAdjustment = properties.epochAdjustmentSeconds;
    const blockTime = await ctx.getAverageBlockTime(currentHeight);
    const avgSeconds = roundTo(blockTime.averageBlockTimeMs / 1000, 2);
    const now = ctx.now();
    const current = {
      height: currentHeight,
      finalizationEpoch: chain.latestFinalizedBlock.finalizationEpoch,
      votingSetGrouping: G,
      averageBlockTimeSeconds: avgSeconds,
    };

    /** Exact time for a past height, estimate for a future one. */
    const timeAtHeight = async (h: number) => {
      if (h <= currentHeight) {
        const block = await ctx.rest.get(`/blocks/${h}`, BlockInfoSchema);
        const date = networkTimestampToDate(block.block.timestamp, epochAdjustment);
        return { date, networkTimestampMs: Number(block.block.timestamp), estimate: false };
      }
      const date = estimateDateAtHeight(currentHeight, h, blockTime.averageBlockTimeMs, now);
      return {
        date,
        networkTimestampMs: dateToNetworkTimestamp(date, epochAdjustment),
        estimate: true,
      };
    };
    const estimateMethod = `Estimated: (target height - current height ${formatInteger(currentHeight)}) x measured average block time ${avgSeconds}s (last ${formatInteger(blockTime.sampleBlocks)} blocks).`;

    if (height !== undefined) {
      const e = heightToEpoch(height, G);
      const t = await timeAtHeight(height);
      const time = ctx.instant(t.date);
      return {
        summary: `Height ${formatInteger(height)} on ${ctx.network.name} is in finalization epoch ${e} (heights ${formatInteger(epochStartHeight(e, G))}-${formatInteger(epochEndHeight(e, G))}) and ${t.estimate ? 'is expected around' : 'was produced at'} ${formatInstantText(time)} (network timestamp ${t.networkTimestampMs} ms).${t.estimate ? ` ${estimateMethod}` : ''}`,
        network: ctx.network.name,
        input: { kind: 'height' as const, value: height },
        height,
        epoch: e,
        epochRange: { startHeight: epochStartHeight(e, G), endHeight: epochEndHeight(e, G) },
        networkTimestampMs: t.networkTimestampMs,
        time,
        epochEnd: null,
        isEstimate: t.estimate,
        method: t.estimate ? estimateMethod : `Exact: timestamp of block ${formatInteger(height)}.`,
        current,
      };
    }

    if (epoch !== undefined) {
      const startHeight = epochStartHeight(epoch, G);
      const endHeight = epochEndHeight(epoch, G);
      const [start, end] = await Promise.all([timeAtHeight(startHeight), timeAtHeight(endHeight)]);
      const time = ctx.instant(start.date);
      const endTime = ctx.instant(end.date);
      const isEstimate = start.estimate || end.estimate;
      const status =
        epoch < current.finalizationEpoch
          ? 'past'
          : epoch === current.finalizationEpoch
            ? 'current'
            : 'future';
      return {
        summary: `Epoch ${epoch} on ${ctx.network.name} (${status}; current finalization epoch ${current.finalizationEpoch}) covers heights ${formatInteger(startHeight)}-${formatInteger(endHeight)}: starts ${formatInstantText(time)}, ends ${formatInstantText(endTime)}.${isEstimate ? ` ${estimateMethod}` : ''}`,
        network: ctx.network.name,
        input: { kind: 'epoch' as const, value: epoch },
        height: startHeight,
        epoch,
        epochRange: { startHeight, endHeight },
        networkTimestampMs: start.networkTimestampMs,
        time,
        epochEnd: { height: endHeight, networkTimestampMs: end.networkTimestampMs, time: endTime },
        isEstimate,
        method: isEstimate
          ? estimateMethod
          : 'Exact: timestamps of the first and last block of the epoch.',
        current,
      };
    }

    if (timestamp === undefined)
      throw new ToolInputError('Pass exactly one of height, epoch or timestamp.');
    const date = networkTimestampToDate(timestamp, epochAdjustment);
    const time = ctx.instant(date);
    // Height is estimated from the offset to "now" using the measured block time.
    const deltaMs = date.getTime() - now.getTime();
    const estimatedHeight = Math.max(
      1,
      Math.round(currentHeight + deltaMs / blockTime.averageBlockTimeMs),
    );
    const e = heightToEpoch(estimatedHeight, G);
    const method = `Height estimated as current height ${formatInteger(currentHeight)} + (time - now) / measured average block time ${avgSeconds}s; exact only for the current block.`;
    return {
      summary: `Network timestamp ${timestamp} ms on ${ctx.network.name} is ${formatInstantText(time)} (epoch adjustment ${epochAdjustment}s). That is roughly height ${formatInteger(estimatedHeight)}, finalization epoch ${e}. ${method}`,
      network: ctx.network.name,
      input: { kind: 'timestamp' as const, value: timestamp },
      height: estimatedHeight,
      epoch: e,
      epochRange: { startHeight: epochStartHeight(e, G), endHeight: epochEndHeight(e, G) },
      networkTimestampMs: timestamp,
      time,
      epochEnd: null,
      isEstimate: true,
      method,
      current,
    };
  },
});
