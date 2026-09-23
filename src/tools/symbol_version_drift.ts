import * as z from 'zod/v4';
import { type RestClient, RestError } from '../client/rest.js';
import {
  NodeInfoSchema,
  NodePeerSchema,
  NodePeersRawSchema,
  ServerInfoSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { sanitizeUntrusted } from '../domain/sanitize.js';
import {
  decodeVersion,
  deriveVersionDriftVerdict,
  FAR_BEHIND_SHARE,
  type VersionDriftVerdict,
  versionDistribution,
} from '../domain/version.js';
import { defineTool, formatInteger, nullable } from './_shared.js';
import { NODEWATCH_URL } from './symbol_network_compare.js';

const inputSchema = z.object({
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): the distribution and verdict. detailed: also one line per version bucket in the summary.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  verdict: z.enum(['ok', 'behind', 'far_behind', 'unknown']),
  node: z.object({
    version: z.string(),
    versionRaw: z.number(),
    restVersion: nullable(
      z.string(),
      'catapult-rest version from /node/server; null when that request failed.',
    ),
  }),
  sample: z.object({
    size: z.number(),
    source: z.enum(['peers', 'peers+reference']),
    peers: z.number(),
    referenceNodes: z.number(),
    ignored: z.number(),
  }),
  distribution: z.array(z.object({ version: z.string(), count: z.number(), share: z.number() })),
  majorityVersion: nullable(
    z.string(),
    'Most common version in the sample (ties go to the newer version); null when the sample is empty.',
  ),
  newerShare: nullable(
    z.number(),
    'Share of the sample (0 to 1) running a version newer than this node; null when the sample is empty.',
  ),
  farBehindShare: z.number(),
  notes: z.array(z.string()),
});

const VERDICT_TEXT: Record<VersionDriftVerdict, string> = {
  ok: 'ok',
  behind: 'BEHIND the majority',
  far_behind: 'FAR BEHIND the network',
  unknown: 'unknown',
};

const NOTES = [
  `The sample is the set of peers the configured node currently knows plus the reference nodes in SYMBOL_REFERENCE_NODES, not the whole network; the full picture is at ${NODEWATCH_URL}.`,
  'Peer entries are untrusted data written by other nodes; only their version and count are reported, never their host, name or public key.',
  'Peers and reference nodes on another network, unreachable reference nodes and malformed peer entries are excluded from the sample.',
];

/** Longest catapult-rest version string kept (untrusted text from /node/server, e.g. "2.5.0"). */
export const MAX_REST_VERSION_LENGTH = 64;

interface ReferenceProbe {
  readonly version: string | null;
  readonly excluded: 'unreachable' | 'other_network' | null;
}

async function probeReference(client: RestClient, seed: string): Promise<ReferenceProbe> {
  try {
    const info = await client.get('/node/info', NodeInfoSchema);
    if (info.networkGenerationHashSeed.toUpperCase() !== seed.toUpperCase()) {
      return { version: null, excluded: 'other_network' };
    }
    return { version: decodeVersion(info.version), excluded: null };
  } catch (err) {
    if (err instanceof RestError) return { version: null, excluded: 'unreachable' };
    throw err;
  }
}

export const versionDriftTool = defineTool({
  name: 'symbol_version_drift',
  title: 'Symbol node version drift',
  description:
    "Check whether the configured Symbol node's software version is behind the network majority: reads the node's own version (/node/info) and REST version (/node/server), collects the versions of the peers the node knows (/node/peers) and of the reference nodes in SYMBOL_REFERENCE_NODES, and reports the version distribution, the majority version, the share of the sample running something newer, and a verdict: ok (same as or newer than the majority), behind (older than the majority, or newer versions hold at least half the sample), far_behind (newer versions hold at least 75%: peers may start refusing connections), or unknown (no peers). Peer hosts and keys are never reported. Key check after a node OS or tooling migration.",
  inputSchema,
  outputSchema,
  run: async (ctx: AppContext, { format }) => {
    const seed = ctx.network.generationHashSeed;
    const [info, serverInfo, rawPeers, references] = await Promise.all([
      ctx.rest.get('/node/info', NodeInfoSchema),
      ctx.rest.get('/node/server', ServerInfoSchema).then(
        (s) => sanitizeUntrusted(s.serverInfo.restVersion, MAX_REST_VERSION_LENGTH),
        (err: unknown) => {
          if (err instanceof RestError) return null;
          throw err;
        },
      ),
      ctx.rest.get('/node/peers', NodePeersRawSchema).then(
        (p) => p,
        (err: unknown) => {
          if (err instanceof RestError) return null;
          throw err;
        },
      ),
      Promise.all(ctx.referenceClients().map((c) => probeReference(c, seed))),
    ]);
    const ownVersion = decodeVersion(info.version);
    const ownKey = info.publicKey.toUpperCase();
    const notes = [...NOTES];

    const peerVersions: string[] = [];
    let ignored = 0;
    if (rawPeers === null) {
      notes.push(`${ctx.rest.host} did not answer /node/peers, so the sample has no peers.`);
    } else {
      for (const entry of rawPeers) {
        const parsed = NodePeerSchema.safeParse(entry);
        if (!parsed.success) {
          ignored++;
          continue;
        }
        const peer = parsed.data;
        if (peer.networkGenerationHashSeed.toUpperCase() !== seed.toUpperCase()) {
          ignored++;
          continue;
        }
        if (peer.publicKey.toUpperCase() === ownKey) {
          ignored++;
          continue;
        }
        peerVersions.push(decodeVersion(peer.version));
      }
    }
    if (ignored > 0) {
      notes.push(
        `${formatInteger(ignored)} peer entr${ignored === 1 ? 'y was' : 'ies were'} ignored (malformed, on another network, or the node itself).`,
      );
    }

    const referenceVersions = references.flatMap((r) => (r.version ? [r.version] : []));
    const unreachable = references.filter((r) => r.excluded === 'unreachable').length;
    const otherNetwork = references.filter((r) => r.excluded === 'other_network').length;
    if (unreachable > 0)
      notes.push(`${formatInteger(unreachable)} reference node(s) could not be reached.`);
    if (otherNetwork > 0) {
      notes.push(
        `${formatInteger(otherNetwork)} reference node(s) are on another network and were excluded.`,
      );
    }

    const dist = versionDistribution([...peerVersions, ...referenceVersions], ownVersion);
    const verdict = deriveVersionDriftVerdict(ownVersion, dist);
    const source: 'peers' | 'peers+reference' =
      referenceVersions.length > 0 ? 'peers+reference' : 'peers';

    const lines: string[] = [];
    if (verdict === 'unknown') {
      lines.push(
        `version drift: unknown. ${ctx.rest.host} runs ${ownVersion} but the sample is empty (no usable peers${references.length > 0 ? ' or reference nodes' : ''}).`,
      );
      lines.push(
        `- ${ctx.rest.host} knows no peers: check peer connectivity with symbol_node_health and symbol_node_status, or set SYMBOL_REFERENCE_NODES to compare against known nodes.`,
      );
    } else {
      const newerPct = Math.round((dist.newerShare ?? 0) * 100);
      lines.push(
        `version drift: ${VERDICT_TEXT[verdict]}. ${ctx.rest.host} runs ${ownVersion}; majority of ${formatInteger(dist.size)} sampled nodes runs ${dist.majorityVersion}; ${newerPct}% run something newer.`,
      );
      if (verdict === 'far_behind') {
        lines.push(
          '- Most of the network is newer: peers may start refusing connections to this node. Upgrade the node software as soon as possible.',
        );
      } else if (verdict === 'behind') {
        lines.push(
          '- Newer versions are taking over: plan the upgrade before peers stop connecting.',
        );
      }
      if (format === 'detailed') {
        for (const b of dist.distribution) {
          lines.push(`- ${b.version}: ${formatInteger(b.count)} (${Math.round(b.share * 100)}%)`);
        }
      }
    }

    return {
      summary: lines.join('\n'),
      network: ctx.network.name,
      verdict,
      node: { version: ownVersion, versionRaw: info.version, restVersion: serverInfo },
      sample: {
        size: dist.size,
        source,
        peers: peerVersions.length,
        referenceNodes: referenceVersions.length,
        ignored,
      },
      distribution: [...dist.distribution],
      majorityVersion: dist.majorityVersion,
      newerShare: dist.newerShare,
      farBehindShare: FAR_BEHIND_SHARE,
      notes,
    };
  },
});
