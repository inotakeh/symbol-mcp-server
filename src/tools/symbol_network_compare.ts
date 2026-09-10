import * as z from 'zod/v4';
import { type RestClient, RestError } from '../client/rest.js';
import { ChainInfoSchema, NodeInfoSchema } from '../client/schemas.js';
import { parseHeight } from '../domain/epoch.js';
import { findNetworkBySeed } from '../domain/network.js';
import { defineTool, formatInteger, nullable } from './_shared.js';

/** A node this many blocks (or more) behind the best reference is reported as lagging. */
export const LAG_THRESHOLD_BLOCKS = 10;
export const NODEWATCH_URL = 'https://nodewatch.symbol.tools/';

const NodeReportSchema = z.object({
  url: z.string(),
  host: z.string(),
  role: z.enum(['own', 'reference']),
  reachable: z.boolean(),
  network: nullable(z.string(), 'Network the node reports; null when unreachable.'),
  sameNetwork: nullable(
    z.boolean(),
    'Whether it is on the configured network; null when unreachable.',
  ),
  height: nullable(z.number(), 'Chain height; null when unreachable.'),
  finalizedHeight: nullable(z.number(), 'Finalized height; null when unreachable.'),
  finalizationEpoch: nullable(z.number(), 'Finalization epoch; null when unreachable.'),
  heightBehindBest: nullable(
    z.number(),
    'Blocks behind the highest reachable node; null when unreachable.',
  ),
  error: nullable(z.string(), 'Why the node could not be queried; null when reachable.'),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  referenceNodesConfigured: z.boolean(),
  nodes: z.array(NodeReportSchema),
  best: nullable(
    z.object({ height: z.number(), finalizedHeight: z.number() }),
    'Highest height and finalized height among reachable same-network nodes; null when none.',
  ),
  own: z.object({
    heightBehindBest: nullable(
      z.number(),
      'Blocks the own node is behind the best; null when unreachable.',
    ),
    finalizedBehindBest: nullable(
      z.number(),
      'Finalized blocks behind the best; null when unreachable.',
    ),
    lagging: z.boolean(),
    finalizationLagging: z.boolean(),
  }),
  thresholdBlocks: z.number(),
  note: z.string(),
});

type NodeReport = z.output<typeof NodeReportSchema>;

async function probe(
  client: RestClient,
  role: 'own' | 'reference',
  expectedNetwork: string,
): Promise<NodeReport> {
  const base = { url: client.baseUrl, host: client.host, role };
  try {
    const [chain, info] = await Promise.all([
      client.get('/chain/info', ChainInfoSchema),
      client.get('/node/info', NodeInfoSchema),
    ]);
    const network = findNetworkBySeed(info.networkGenerationHashSeed)?.name ?? 'unknown';
    return {
      ...base,
      reachable: true,
      network,
      sameNetwork: network === expectedNetwork,
      height: parseHeight(chain.height),
      finalizedHeight: parseHeight(chain.latestFinalizedBlock.height),
      finalizationEpoch: chain.latestFinalizedBlock.finalizationEpoch,
      heightBehindBest: null,
      error: null,
    };
  } catch (err) {
    const error =
      err instanceof RestError
        ? `${err.kind}: ${err.message}`
        : `error: ${err instanceof Error ? err.message : String(err)}`;
    return {
      ...base,
      reachable: false,
      network: null,
      sameNetwork: null,
      height: null,
      finalizedHeight: null,
      finalizationEpoch: null,
      heightBehindBest: null,
      error,
    };
  }
}

export const networkCompareTool = defineTool({
  name: 'symbol_network_compare',
  title: 'Symbol node comparison',
  description:
    'Compare the configured node with the reference nodes listed in SYMBOL_REFERENCE_NODES: height, finalized height and finalization epoch of each, the best values seen, how far the own node is behind, and lagging flags (more than 10 blocks behind). Only the configured node and the listed reference nodes are ever contacted. Takes no arguments.',
  inputSchema: undefined,
  outputSchema,
  run: async (ctx) => {
    const references = ctx.referenceClients();
    const expected = ctx.network.name;
    const reports = await Promise.all([
      probe(ctx.rest, 'own', expected),
      ...references.map((c) => probe(c, 'reference', expected)),
    ]);

    const comparable = reports.filter((r) => r.reachable && r.sameNetwork === true);
    const best =
      comparable.length > 0
        ? {
            height: Math.max(...comparable.map((r) => r.height ?? 0)),
            finalizedHeight: Math.max(...comparable.map((r) => r.finalizedHeight ?? 0)),
          }
        : null;
    const nodes = reports.map((r) =>
      r.reachable && best && r.height !== null
        ? { ...r, heightBehindBest: best.height - r.height }
        : r,
    );
    const own = nodes[0];
    const ownBehind =
      own?.reachable && best && own.height !== null ? best.height - own.height : null;
    const ownFinalizedBehind =
      own?.reachable && best && own.finalizedHeight !== null
        ? best.finalizedHeight - own.finalizedHeight
        : null;
    const lagging = ownBehind !== null && ownBehind > LAG_THRESHOLD_BLOCKS;
    const finalizationLagging =
      ownFinalizedBehind !== null && ownFinalizedBehind > LAG_THRESHOLD_BLOCKS;

    const lines: string[] = [];
    if (references.length === 0) {
      lines.push(
        `No reference nodes are configured, so there is nothing to compare against. ${own?.reachable ? `${own.host} is at height ${formatInteger(own.height ?? 0)}, finalized ${formatInteger(own.finalizedHeight ?? 0)} (epoch ${own.finalizationEpoch}).` : `${ctx.rest.host} could not be reached (${own?.error}).`} Set SYMBOL_REFERENCE_NODES to a comma-separated list of https node URLs; public nodes are listed at ${NODEWATCH_URL}.`,
      );
    } else {
      lines.push(
        `${ctx.rest.host} vs ${references.length} reference node${references.length === 1 ? '' : 's'} on ${expected}: ${
          own?.reachable
            ? lagging
              ? `LAGGING by ${formatInteger(ownBehind ?? 0)} blocks (threshold ${LAG_THRESHOLD_BLOCKS}).`
              : `in sync (${formatInteger(ownBehind ?? 0)} blocks behind the best node${finalizationLagging ? `, but finalization is ${formatInteger(ownFinalizedBehind ?? 0)} blocks behind` : ''}).`
            : `own node unreachable (${own?.error}).`
        }`,
      );
      for (const n of nodes) {
        lines.push(
          n.reachable
            ? `- ${n.role === 'own' ? 'own ' : ''}${n.host}: height ${formatInteger(n.height ?? 0)} (${n.heightBehindBest === 0 ? 'best' : `-${formatInteger(n.heightBehindBest ?? 0)}`}), finalized ${formatInteger(n.finalizedHeight ?? 0)}, epoch ${n.finalizationEpoch}${n.sameNetwork ? '' : ` [WRONG NETWORK: ${n.network}]`}`
            : `- ${n.role === 'own' ? 'own ' : ''}${n.host}: unreachable (${n.error})`,
        );
      }
    }

    return {
      summary: lines.join('\n'),
      network: expected,
      referenceNodesConfigured: references.length > 0,
      nodes,
      best,
      own: {
        heightBehindBest: ownBehind,
        finalizedBehindBest: ownFinalizedBehind,
        lagging,
        finalizationLagging,
      },
      thresholdBlocks: LAG_THRESHOLD_BLOCKS,
      note: `A node more than ${LAG_THRESHOLD_BLOCKS} blocks behind the best reachable same-network node is flagged lagging. Nodes on a different network are excluded from the comparison. Reference nodes come only from SYMBOL_REFERENCE_NODES.`,
    };
  },
});
