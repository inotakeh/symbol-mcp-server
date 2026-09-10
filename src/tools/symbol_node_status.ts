import * as z from 'zod/v4';
import {
  BlockInfoSchema,
  ChainInfoSchema,
  NodeHealthSchema,
  NodeInfoSchema,
  NodePeersSchema,
} from '../client/schemas.js';
import { parseHeight } from '../domain/epoch.js';
import { findNetworkBySeed } from '../domain/network.js';
import { decodeRoles } from '../domain/roles.js';
import { sanitizeUntrusted } from '../domain/sanitize.js';
import { networkTimestampToDate } from '../domain/time.js';
import { decodeVersion } from '../domain/version.js';
import { defineTool, formatInteger, nullable } from './_shared.js';

const InstantSchema = z.object({ utc: z.string(), local: z.string().optional() });

const outputSchema = z.object({
  summary: z.string(),
  node: z.object({
    friendlyName: z.string(),
    host: z.string(),
    port: nullable(z.number(), 'Peer port reported by the node; null when not reported.'),
    roles: z.array(z.string()),
    rolesRaw: z.number(),
    version: z.string(),
    versionRaw: z.number(),
    publicKey: z.string(),
    nodePublicKey: nullable(z.string(), 'Node (TLS) public key; null when not reported.'),
  }),
  network: z.object({
    name: z.string(),
    identifier: z.number(),
    matchesConfiguredNetwork: z.boolean(),
  }),
  health: z.object({ apiNode: z.string(), db: z.string(), healthy: z.boolean() }),
  chain: z.object({
    height: z.number(),
    finalizedHeight: z.number(),
    finalizationEpoch: z.number(),
    finalizationPoint: z.number(),
  }),
  peers: z.object({ count: z.number() }),
  sync: z.object({
    latestBlockTime: InstantSchema,
    checkedAt: InstantSchema,
    ageSeconds: z.number(),
    synced: z.boolean(),
    thresholdSeconds: z.number(),
  }),
  warnings: z.array(z.string()),
});

export const SYNC_THRESHOLD_SECONDS = 300;

export const nodeStatusTool = defineTool({
  name: 'symbol_node_status',
  title: 'Symbol node status',
  description:
    'Report the health of the configured Symbol node (SYMBOL_NODE_URL): friendly name, host, roles (Peer/API/Voting), software version, network, API and database health, current and finalized height, finalization epoch, peer count, and whether the node is in sync (latest block older than 5 minutes means not synced). Takes no arguments.',
  inputSchema: undefined,
  outputSchema,
  run: async (ctx) => {
    const [info, health, chain, peers, { properties }] = await Promise.all([
      ctx.rest.get('/node/info', NodeInfoSchema),
      ctx.rest.get('/node/health', NodeHealthSchema),
      ctx.rest.get('/chain/info', ChainInfoSchema),
      ctx.rest.get('/node/peers', NodePeersSchema),
      ctx.getNetworkData(),
    ]);
    const height = parseHeight(chain.height);
    const latest = await ctx.rest.get(`/blocks/${height}`, BlockInfoSchema);

    const now = ctx.now();
    const latestBlockDate = networkTimestampToDate(
      latest.block.timestamp,
      properties.epochAdjustmentSeconds,
    );
    const ageSeconds = Math.round((now.getTime() - latestBlockDate.getTime()) / 1000);
    const synced = ageSeconds <= SYNC_THRESHOLD_SECONDS;
    const healthy = health.status.apiNode === 'up' && health.status.db === 'up';

    const nodeNetwork = findNetworkBySeed(info.networkGenerationHashSeed);
    const matchesConfiguredNetwork = nodeNetwork?.name === ctx.network.name;

    const friendlyName = sanitizeUntrusted(info.friendlyName ?? '');
    const host = sanitizeUntrusted(info.host ?? '');
    const roles = decodeRoles(info.roles);
    const version = decodeVersion(info.version);

    const warnings: string[] = [];
    if (!synced) {
      warnings.push(
        `Latest block is ${ageSeconds} seconds old (threshold ${SYNC_THRESHOLD_SECONDS}s); the node appears to be behind or stalled.`,
      );
    }
    if (!healthy) {
      warnings.push(`Node health: apiNode=${health.status.apiNode}, db=${health.status.db}.`);
    }
    if (!matchesConfiguredNetwork) {
      warnings.push('The node now reports a different network than at startup.');
    }

    const summary = [
      `${friendlyName || host || ctx.rest.host} (${host || ctx.rest.host}) runs Symbol ${version} on ${ctx.network.name} with roles ${roles.join('/') || 'none'}.`,
      `Health apiNode=${health.status.apiNode}, db=${health.status.db}; height ${formatInteger(height)}, finalized ${formatInteger(parseHeight(chain.latestFinalizedBlock.height))} (epoch ${chain.latestFinalizedBlock.finalizationEpoch}); ${peers.length} peers.`,
      synced
        ? `Synced: latest block ${ageSeconds}s old.`
        : `NOT synced: latest block ${ageSeconds}s old (threshold ${SYNC_THRESHOLD_SECONDS}s).`,
    ].join('\n');

    return {
      summary,
      node: {
        friendlyName,
        host,
        port: info.port ?? null,
        roles,
        rolesRaw: info.roles,
        version,
        versionRaw: info.version,
        publicKey: info.publicKey,
        nodePublicKey: info.nodePublicKey ?? null,
      },
      network: {
        name: nodeNetwork?.name ?? 'unknown',
        identifier: info.networkIdentifier,
        matchesConfiguredNetwork,
      },
      health: { apiNode: health.status.apiNode, db: health.status.db, healthy },
      chain: {
        height,
        finalizedHeight: parseHeight(chain.latestFinalizedBlock.height),
        finalizationEpoch: chain.latestFinalizedBlock.finalizationEpoch,
        finalizationPoint: chain.latestFinalizedBlock.finalizationPoint,
      },
      peers: { count: peers.length },
      sync: {
        latestBlockTime: ctx.instant(latestBlockDate),
        checkedAt: ctx.instant(now),
        ageSeconds,
        synced,
        thresholdSeconds: SYNC_THRESHOLD_SECONDS,
      },
      warnings,
    };
  },
});
