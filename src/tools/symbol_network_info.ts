import * as z from 'zod/v4';
import { ChainInfoSchema, TransactionFeesSchema } from '../client/schemas.js';
import { parseHeight } from '../domain/epoch.js';
import { defineTool, formatInteger, nullable } from './_shared.js';

const outputSchema = z.object({
  summary: z.string(),
  network: z.object({
    name: z.string(),
    identifier: z.number(),
    generationHashSeed: z.string(),
  }),
  chain: z.object({
    height: z.number(),
    finalizedHeight: z.number(),
    finalizationEpoch: z.number(),
    finalizationPoint: z.number(),
  }),
  blockGenerationTargetTimeSeconds: z.number(),
  votingSetGrouping: z.number(),
  epochAdjustment: z.object({ seconds: z.number(), utc: z.string() }),
  currency: z.object({
    mosaicId: z.string(),
    alias: nullable(z.string(), 'Alias of the currency mosaic (symbol.xym); null when none.'),
    divisibility: z.number(),
  }),
  fees: z.object({
    minFeeMultiplier: z.number(),
    averageFeeMultiplier: z.number(),
    medianFeeMultiplier: z.number(),
    highestFeeMultiplier: z.number(),
    lowestFeeMultiplier: z.number(),
  }),
  node: z.object({ url: z.string() }),
});

export const networkInfoTool = defineTool({
  name: 'symbol_network_info',
  title: 'Symbol network info',
  description:
    'Describe the Symbol network the configured node belongs to: network name and identifier, generation hash seed, current and finalized block height, finalization epoch, block target time, voting set grouping, epoch adjustment, the native currency mosaic (XYM) id/alias/divisibility, and current transaction fee multipliers. Takes no arguments; the node is fixed by SYMBOL_NODE_URL.',
  inputSchema: undefined,
  outputSchema,
  run: async (ctx) => {
    const [{ properties, currency }, chain, fees] = await Promise.all([
      ctx.getNetworkData(),
      ctx.rest.get('/chain/info', ChainInfoSchema),
      ctx.rest.get('/network/fees/transaction', TransactionFeesSchema),
    ]);
    const height = parseHeight(chain.height);
    const finalizedHeight = parseHeight(chain.latestFinalizedBlock.height);
    const epochAdjustmentUtc = new Date(properties.epochAdjustmentSeconds * 1000).toISOString();

    const summary = [
      `Symbol ${ctx.network.name} (identifier ${ctx.network.identifier}) via ${ctx.rest.host}: height ${formatInteger(height)}, finalized ${formatInteger(finalizedHeight)} (epoch ${chain.latestFinalizedBlock.finalizationEpoch}).`,
      `Currency ${currency.alias ?? currency.mosaicId} = mosaic ${currency.mosaicId}, divisibility ${currency.divisibility}; block target ${properties.blockGenerationTargetTimeMs / 1000}s, voting set grouping ${properties.votingSetGrouping}.`,
      `Fee multipliers: min ${fees.minFeeMultiplier}, average ${fees.averageFeeMultiplier}, median ${fees.medianFeeMultiplier}, highest ${fees.highestFeeMultiplier}.`,
    ].join('\n');

    return {
      summary,
      network: {
        name: ctx.network.name,
        identifier: ctx.network.identifier,
        generationHashSeed: ctx.network.generationHashSeed,
      },
      chain: {
        height,
        finalizedHeight,
        finalizationEpoch: chain.latestFinalizedBlock.finalizationEpoch,
        finalizationPoint: chain.latestFinalizedBlock.finalizationPoint,
      },
      blockGenerationTargetTimeSeconds: properties.blockGenerationTargetTimeMs / 1000,
      votingSetGrouping: properties.votingSetGrouping,
      epochAdjustment: { seconds: properties.epochAdjustmentSeconds, utc: epochAdjustmentUtc },
      currency: {
        mosaicId: currency.mosaicId,
        alias: currency.alias,
        divisibility: currency.divisibility,
      },
      fees: {
        minFeeMultiplier: fees.minFeeMultiplier,
        averageFeeMultiplier: fees.averageFeeMultiplier,
        medianFeeMultiplier: fees.medianFeeMultiplier,
        highestFeeMultiplier: fees.highestFeeMultiplier,
        lowestFeeMultiplier: fees.lowestFeeMultiplier,
      },
      node: { url: ctx.config.nodeUrl },
    };
  },
});
