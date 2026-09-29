import * as z from 'zod/v4';
import { type RestClient, RestError } from '../client/rest.js';
import { ChainInfoSchema, NodeInfoSchema } from '../client/schemas.js';
import { parseHeight } from '../domain/epoch.js';
import { findNetworkBySeed } from '../domain/network.js';
import { defineTool, formatInteger, logUnexpectedError, nullable } from './_shared.js';

/**
 * A node more than this many blocks behind the best reachable same-network node (the own node
 * included) is reported as lagging.
 */
export const LAG_THRESHOLD_BLOCKS = 10;
export const NODEWATCH_URL = 'https://nodewatch.symbol.tools/';

/**
 * `nodes[].error` for a failure that is not a RestError (an internal error, or a value such as a
 * height beyond the safe integer range); the details go to stderr, as with describeError.
 */
export const INTERNAL_ERROR_TEXT =
  'error: unexpected internal error while reading this node (details were written to the server log)';

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
    let error: string;
    if (err instanceof RestError) {
      error = `${err.kind}: ${err.message}`;
    } else {
      // The message may quote node data, so it goes to stderr and the output gets a fixed text.
      logUnexpectedError(err, `${role} node ${client.host}`);
      error = INTERNAL_ERROR_TEXT;
    }
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
    'Measure how many blocks the configured node trails the reference nodes listed in SYMBOL_REFERENCE_NODES, comparing height, finalized height and finalization epoch. For whether the node is in sync on its own (the age of its latest block), use symbol_node_status; for whether its services are healthy, symbol_node_health; for whether its software version is behind, symbol_version_drift. Reports the values of each node, the best values seen, how far the own node is behind, and lagging flags (more than 10 blocks behind). Only the configured node and the listed reference nodes are ever contacted. Takes no arguments.',
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
      // Only a reference that answered on the configured network is compared; without one, the
      // own node is the only "best" there is, and 0 blocks behind would say nothing.
      const referenceReports = nodes.slice(1);
      const notCompared = referenceReports.filter((r) => !(r.reachable && r.sameNetwork === true));
      const compared = referenceReports.length - notCompared.length;
      const unanswered = notCompared.filter((r) => !r.reachable).length;
      const otherNetwork = notCompared.length - unanswered;
      const whyNot = [
        unanswered > 0 ? `${unanswered} did not answer` : null,
        otherNetwork > 0
          ? `${otherNetwork} ${otherNetwork === 1 ? 'is' : 'are'} on another network`
          : null,
      ]
        .filter((part) => part !== null)
        .join(', ');
      const head = `${ctx.rest.host} vs ${references.length} reference node${references.length === 1 ? '' : 's'} on ${expected}`;
      if (!own?.reachable) {
        lines.push(`${head}: own node unreachable (${own?.error}).`);
      } else if (compared === 0) {
        lines.push(
          `${head}: could not compare, because no reference node could be read on ${expected} (${whyNot}; details below).`,
          'The heightBehindBest 0 and lagging false in the structured output compare the own node with itself only; they say nothing about how far it trails the network.',
        );
      } else {
        const verdict = lagging
          ? `LAGGING by ${formatInteger(ownBehind ?? 0)} blocks (threshold ${LAG_THRESHOLD_BLOCKS})`
          : `in sync (${formatInteger(ownBehind ?? 0)} blocks behind the best node${finalizationLagging ? `, but finalization is ${formatInteger(ownFinalizedBehind ?? 0)} blocks behind` : ''})`;
        const partial =
          notCompared.length > 0
            ? `, compared with ${compared} of ${references.length} reference nodes; not compared (${whyNot}): ${notCompared.map((r) => r.host).join(', ')}`
            : '';
        lines.push(`${head}: ${verdict}${partial}.`);
      }
      for (const n of nodes) {
        const where =
          compared === 0
            ? ''
            : ` (${n.heightBehindBest === 0 ? 'best' : `-${formatInteger(n.heightBehindBest ?? 0)}`})`;
        lines.push(
          n.reachable
            ? `- ${n.role === 'own' ? 'own ' : ''}${n.host}: height ${formatInteger(n.height ?? 0)}${where}, finalized ${formatInteger(n.finalizedHeight ?? 0)}, epoch ${n.finalizationEpoch}${n.sameNetwork ? '' : ` [WRONG NETWORK: ${n.network}]`}`
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
