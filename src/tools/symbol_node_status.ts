import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import {
  BlockInfoSchema,
  type ChainInfo,
  ChainInfoSchema,
  NodeHealthSchema,
  NodeInfoSchema,
  NodePeersSchema,
  NodeStorageSchema,
  NodeTimeSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import type { DiagnoseCheck } from '../domain/delegation.js';
import { parseHeight } from '../domain/epoch.js';
import { findNetworkBySeed } from '../domain/network.js';
import {
  assessChainTipAge,
  assessClockSkew,
  assessFinalizationLag,
  assessStorage,
  CHAIN_TIP_FAIL_BLOCK_TIMES,
  CHAIN_TIP_WARN_BLOCK_TIMES,
  chainTipThresholds,
  computeClockSkewMs,
  deriveHealthVerdict,
  pickNodeTimestamp,
  serviceStatus,
  serviceStatusSentence,
  skewThresholds,
} from '../domain/nodehealth.js';
import { labelledQuote } from '../domain/quote.js';
import { decodeRoles } from '../domain/roles.js';
import { InvalidNetworkTimestampError, networkTimestampToDate, roundTo } from '../domain/time.js';
import { decodeVersion } from '../domain/version.js';
import { CheckSchema, check, stripOkHints } from './_checks.js';
import { defineTool, formatInteger, nullable } from './_shared.js';
import { InstantSchema } from './_transactions.js';

/** catapult-rest answers /node/health with 503 and the same body when a service is down. */
const HEALTH_ACCEPTED_STATUSES = [503] as const;

const inputSchema = z.object({
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): hints only on checks that are not ok. detailed: a hint on every check, including what was compared for the ok ones.',
    ),
});

const outputSchema = z.object({
  summary: z.string(),
  verdict: z.enum(['healthy', 'degraded', 'unhealthy']),
  sync: z.object({
    synced: nullable(
      z.boolean(),
      'True while the latest block is at most thresholdSeconds old, false beyond that; null when it could not be judged (the chain_tip_age check says why).',
    ),
    latestBlockTime: nullable(
      InstantSchema,
      'Time of the latest block; null when the block could not be read or its timestamp is not a valid time.',
    ),
    ageSeconds: nullable(
      z.number(),
      'checkedAt minus latestBlockTime in whole seconds (negative when the block is ahead of the local clock); null when latestBlockTime is.',
    ),
    thresholdSeconds: z.number(),
    checkedAt: InstantSchema,
  }),
  checks: z.array(CheckSchema),
  node: nullable(
    z.object({
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
    'What the node says it is (/node/info); null when that request failed.',
  ),
  network: nullable(
    z.object({ name: z.string(), identifier: z.number(), matchesConfiguredNetwork: z.boolean() }),
    'The network the node reports now (/node/info); null when that request failed.',
  ),
  chain: nullable(
    z.object({
      height: z.number(),
      finalizedHeight: z.number(),
      finalizationEpoch: z.number(),
      finalizationPoint: z.number(),
    }),
    'From /chain/info; null when that request failed or a height in it is not a valid number.',
  ),
  storage: nullable(
    z.object({ numBlocks: z.number(), numTransactions: z.number(), numAccounts: z.number() }),
    'Counts the node reports from its own database (/node/storage); null when that request failed.',
  ),
  peers: nullable(
    z.object({ count: z.number() }),
    'Peers the node knows (/node/peers); null when that request failed.',
  ),
  time: z.object({
    nodeTime: nullable(
      InstantSchema,
      'Node clock from /node/time (network time converted with epochAdjustment); null when unavailable.',
    ),
    localTime: InstantSchema,
    skewMs: nullable(
      z.number(),
      'nodeTime minus localTime in milliseconds (positive = node ahead); null when unavailable.',
    ),
  }),
  notes: z.array(z.string()),
});

type Output = z.output<typeof outputSchema>;

const NOTES = [
  'clock_skew compares the node clock, and chain_tip_age (and with it sync) the time of the latest block, with the clock of the machine running this server (clock_skew including request latency); the local clock may be the one that is off.',
  'storage counts come from the node database as reported by the node and are not backed by chain data.',
  `Thresholds are derived from the network: one minute of blocks for storage, half and one block time for clock skew, half and one epoch (votingSetGrouping blocks) for finalization lag, ${CHAIN_TIP_WARN_BLOCK_TIMES} and ${CHAIN_TIP_FAIL_BLOCK_TIMES} block times for the age of the latest block (the node counts as synced up to the first).`,
];

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RestError };

/** Turns a RestError into a value so one failing endpoint does not sink the other checks. */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    if (err instanceof RestError) return { ok: false, error: err };
    throw err;
  }
}

/**
 * `read()`, or null when a timestamp the node sent gives no valid time (it may send any uint64):
 * the check that needs the time is then unknown instead of the whole tool failing.
 */
function validTime<T>(read: () => T): T | null {
  try {
    return read();
  } catch (err) {
    if (err instanceof InvalidNetworkTimestampError) return null;
    throw err;
  }
}

function failureText(host: string, path: string, error: RestError): string {
  return `${host} did not answer ${path} (${error.kind}${error.status ? ` ${error.status}` : ''}).`;
}

type ChainRead =
  | { readonly ok: true; readonly value: NonNullable<Output['chain']> }
  | { readonly ok: false; readonly detail: string };

/**
 * /chain/info with its heights as numbers. Not ok, with the reason worded as a check detail, when
 * the request failed or a height is not a safe integer (the node may send any uint64): the checks
 * that need the chain are then unknown instead of the whole tool failing.
 */
function readChain(host: string, chain: Settled<ChainInfo>): ChainRead {
  if (!chain.ok) return { ok: false, detail: failureText(host, '/chain/info', chain.error) };
  const finalized = chain.value.latestFinalizedBlock;
  try {
    return {
      ok: true,
      value: {
        height: parseHeight(chain.value.height),
        finalizedHeight: parseHeight(finalized.height),
        finalizationEpoch: finalized.finalizationEpoch,
        finalizationPoint: finalized.finalizationPoint,
      },
    };
  } catch {
    return {
      ok: false,
      detail: `${host} answered /chain/info with a height that is not a valid number.`,
    };
  }
}

/** Thousands separators and at most `fractionDigits` decimals (none when the value is whole). */
function decimal(value: number, fractionDigits: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: fractionDigits });
}

/** Seconds of a threshold; a fraction only when the block time has one. */
function seconds(value: number): string {
  return decimal(value, 3);
}

/**
 * `about 3.4 min` / `about 2.5 h` / `about 3.1 days` for an age of two minutes or more. The unit is
 * chosen after rounding, so 119.95 minutes reads as 2 h rather than 120 min.
 */
function approximately(ageSeconds: number): string | null {
  if (ageSeconds < 120) return null;
  const minutes = roundTo(ageSeconds / 60, 1);
  if (minutes < 120) return `about ${decimal(minutes, 1)} min`;
  const hours = roundTo(ageSeconds / 3_600, 1);
  if (hours < 48) return `about ${decimal(hours, 1)} h`;
  return `about ${decimal(roundTo(ageSeconds / 86_400, 1), 1)} days`;
}

/** A check that could not be made: `detail` says which answer is missing or unusable. */
function cannotCheck(id: string, detail: string): DiagnoseCheck {
  return check({
    id,
    status: 'unknown',
    detail,
    hint: 'Retry later; the other checks do not depend on it.',
  });
}

export const nodeStatusTool = defineTool({
  name: 'symbol_node_status',
  title: 'Symbol node status and health',
  description:
    'Check whether the configured Symbol node (SYMBOL_NODE_URL) is in sync and its services are healthy right now, and report what it is: one verdict, the synced flag, friendly name, host, roles (Peer/API/Voting), software version, network, current and finalized height, finalization epoch and peer count. For whether its version is behind the network, use symbol_version_drift; for how many blocks it trails other nodes, symbol_network_compare. Seven checks in a fixed order, each ok/warn/fail/unknown with a hint: API node and database status from /node/health (a 503 answer is read, not treated as a failure), node database block count versus chain height, node clock versus the local clock, finalization lag in blocks and minutes, the node roles (is it a voting node), and the age of the latest block against the local clock, which catches a node that has stopped following the chain (warn beyond 10 target block times, fail beyond 30). The verdict is healthy, degraded (a warning, or a check that could not be made) or unhealthy. The synced flag is true while the latest block is at most 10 target block times old (5 minutes on mainnet), false beyond that, and null when that could not be judged. A request that fails, or an answer that cannot be used, makes its check unknown and its fields null instead of failing the call. Thresholds come from the network properties.',
  inputSchema,
  outputSchema,
  untrustedText: true,
  run: async (ctx: AppContext, { format }, text) => {
    const host = ctx.rest.host;
    const chainRequest = settle(ctx.rest.get('/chain/info', ChainInfoSchema)).then((c) =>
      readChain(host, c),
    );
    // The latest block can only be asked for once the chain height is known: one more round trip.
    const latestRequest = chainRequest.then((c) =>
      c.ok ? settle(ctx.rest.get(`/blocks/${c.value.height}`, BlockInfoSchema)) : null,
    );
    // Only the network properties, the source of every threshold, fail the call.
    const [{ properties }, health, storage, time, chain, info, peers, latest] = await Promise.all([
      ctx.getNetworkData(),
      settle(
        ctx.rest.get('/node/health', NodeHealthSchema, {
          acceptStatuses: HEALTH_ACCEPTED_STATUSES,
        }),
      ),
      settle(ctx.rest.get('/node/storage', NodeStorageSchema)),
      settle(ctx.rest.get('/node/time', NodeTimeSchema)),
      chainRequest,
      settle(ctx.rest.get('/node/info', NodeInfoSchema)),
      settle(ctx.rest.get('/node/peers', NodePeersSchema)),
      latestRequest,
    ]);
    const now = ctx.now();
    const blockTimeMs = properties.blockGenerationTargetTimeMs;
    const checks: DiagnoseCheck[] = [];
    // In the summary only, a status the node sent is quoted (serviceStatusSentence);
    // checks[].detail keeps the plain cleaned text.
    const summaryDetails = new Map<string, string>();
    // What no check says: each remark is a note and a line of the summary.
    const remarks: string[] = [];

    // 1-2. api_node, db
    if (health.ok) {
      const apiNode = serviceStatus(health.value.status.apiNode, text);
      const db = serviceStatus(health.value.status.db, text);
      summaryDetails.set('api_node', serviceStatusSentence('API node', apiNode));
      summaryDetails.set('db', serviceStatusSentence('Database', db));
      checks.push(
        apiNode === 'up'
          ? check({
              id: 'api_node',
              status: 'ok',
              detail: 'API node service is up.',
              hint: 'Reported by /node/health status.apiNode.',
            })
          : check({
              id: 'api_node',
              status: 'fail',
              detail: `API node service is ${apiNode}.`,
              hint: 'The REST gateway cannot reach the catapult API node process. Check the node containers/services and their logs, then retry.',
            }),
      );
      checks.push(
        db === 'up'
          ? check({
              id: 'db',
              status: 'ok',
              detail: 'Database service is up.',
              hint: 'Reported by /node/health status.db.',
            })
          : check({
              id: 'db',
              status: 'fail',
              detail: `Database service is ${db}.`,
              hint: 'The REST gateway cannot reach MongoDB. Check the database container/service and disk space, then retry.',
            }),
      );
    } else {
      const detail = failureText(host, '/node/health', health.error);
      const hint =
        'The REST gateway itself is not answering its health route. Check that the REST service is running and reachable, then retry.';
      checks.push(check({ id: 'api_node', status: 'fail', detail, hint }));
      checks.push(check({ id: 'db', status: 'fail', detail, hint }));
    }

    // 3. storage_consistent
    if (!storage.ok) {
      checks.push(
        cannotCheck('storage_consistent', failureText(host, '/node/storage', storage.error)),
      );
    } else if (!chain.ok) {
      checks.push(cannotCheck('storage_consistent', chain.detail));
    } else {
      const { height } = chain.value;
      const a = assessStorage(storage.value.numBlocks, height, blockTimeMs);
      checks.push(
        check({
          id: 'storage_consistent',
          status: a.status,
          detail: `Database holds ${formatInteger(storage.value.numBlocks)} blocks at chain height ${formatInteger(height)} (difference ${formatInteger(a.deltaBlocks)}, tolerance ${formatInteger(a.toleranceBlocks)}).`,
          hint:
            a.status === 'ok'
              ? `Tolerance is about one minute of blocks at the ${formatInteger(blockTimeMs / 1000)}-second block time.`
              : 'The block count in the node database and the chain height disagree by more than a minute of blocks: the database may be behind or inconsistent. Check the broker/REST logs; a resync may be needed if it persists.',
        }),
      );
    }

    // 4. clock_skew
    const nodeTimestamp = time.ok ? pickNodeTimestamp(time.value.communicationTimestamps) : null;
    const clock =
      nodeTimestamp === null
        ? null
        : validTime(() => ({
            nodeDate: networkTimestampToDate(nodeTimestamp, properties.epochAdjustmentSeconds),
            skewMs: computeClockSkewMs(nodeTimestamp, properties.epochAdjustmentSeconds, now),
          }));
    if (clock !== null) {
      const status = assessClockSkew(clock.skewMs, blockTimeMs);
      const { warnMs, failMs } = skewThresholds(blockTimeMs);
      const direction = clock.skewMs >= 0 ? 'ahead of' : 'behind';
      checks.push(
        check({
          id: 'clock_skew',
          status,
          detail: `Node clock is ${formatInteger(Math.abs(clock.skewMs))} ms ${direction} this machine's clock (warn at ${formatInteger(warnMs)} ms, fail at ${formatInteger(failMs)} ms).`,
          hint:
            status === 'ok'
              ? 'Within half a block time; harvesting and transaction deadlines are unaffected.'
              : 'A node clock off by a block time or more makes harvested blocks and announced transactions fail their time checks. Enable NTP/chrony on the node host (and on this machine, which may be the one that is off) and re-check.',
        }),
      );
    } else {
      checks.push(
        cannotCheck(
          'clock_skew',
          !time.ok
            ? failureText(host, '/node/time', time.error)
            : nodeTimestamp === null
              ? `${host} answered /node/time without a timestamp.`
              : `${host} answered /node/time with a timestamp that is not a valid time.`,
        ),
      );
    }

    // 5. finalization_lag
    if (chain.ok) {
      const { height, finalizedHeight } = chain.value;
      const lag = assessFinalizationLag(
        height,
        finalizedHeight,
        properties.votingSetGrouping,
        blockTimeMs,
      );
      checks.push(
        check({
          id: 'finalization_lag',
          status: lag.status,
          detail: `Finalized height ${formatInteger(finalizedHeight)} is ${formatInteger(lag.lagBlocks)} blocks (about ${lag.lagMinutes} min) behind height ${formatInteger(height)} (warn at ${formatInteger(lag.warnBlocks)}, fail at ${formatInteger(lag.failBlocks)} blocks).`,
          hint:
            lag.status === 'ok'
              ? 'Less than half an epoch behind is normal finalization progress.'
              : 'Finalization has fallen behind by half an epoch or more. If reference nodes agree, the network is finalizing slowly; if only this node lags, it is not receiving finalization messages (check peers and the voting configuration).',
        }),
      );
    } else {
      checks.push(cannotCheck('finalization_lag', chain.detail));
    }

    // 6. roles
    let node: Output['node'] = null;
    let network: Output['network'] = null;
    if (info.ok) {
      const roles = decodeRoles(info.value.roles);
      const reportedNetwork = findNetworkBySeed(info.value.networkGenerationHashSeed);
      node = {
        friendlyName: text.clean(info.value.friendlyName ?? ''),
        host: text.clean(info.value.host ?? ''),
        port: info.value.port ?? null,
        roles,
        rolesRaw: info.value.roles,
        version: decodeVersion(info.value.version),
        versionRaw: info.value.version,
        publicKey: info.value.publicKey,
        nodePublicKey: info.value.nodePublicKey ?? null,
      };
      network = {
        name: reportedNetwork?.name ?? 'unknown',
        identifier: info.value.networkIdentifier,
        matchesConfiguredNetwork: reportedNetwork?.name === ctx.network.name,
      };
      checks.push(
        check({
          id: 'roles',
          status: 'ok',
          detail: `Roles ${roles.join('/') || 'none'} (${roles.includes('Voting') ? 'a voting node' : 'not a voting node'}).`,
          hint: 'Informational: decoded from the roles bit flags of /node/info.',
        }),
      );
      if (!network.matchesConfiguredNetwork) {
        remarks.push(
          `The node now reports a different network (${network.name}) than at start-up (${ctx.network.name}). Check SYMBOL_NODE_URL and restart this server: its network properties were read at start-up.`,
        );
      }
    } else {
      checks.push(cannotCheck('roles', failureText(host, '/node/info', info.error)));
    }

    // 7. chain_tip_age
    const thresholds = chainTipThresholds(blockTimeMs);
    const tip = latest?.ok
      ? validTime(() =>
          assessChainTipAge(
            latest.value.block.timestamp,
            properties.epochAdjustmentSeconds,
            now,
            thresholds,
          ),
        )
      : null;
    if (chain.ok && tip !== null) {
      const { height } = chain.value;
      const limits = `warn above ${seconds(thresholds.warnSeconds)} s, fail above ${seconds(thresholds.failSeconds)} s`;
      const about = approximately(tip.ageSeconds);
      checks.push(
        check({
          id: 'chain_tip_age',
          status: tip.status,
          detail:
            tip.ageSeconds < 0
              ? `Latest block (height ${formatInteger(height)}) is timestamped ${formatInteger(-tip.ageSeconds)} s ahead of this machine's clock, so it is not old (${limits}).`
              : `Latest block (height ${formatInteger(height)}) is ${formatInteger(tip.ageSeconds)} s old (${about === null ? '' : `${about}; `}${limits}).`,
          hint:
            tip.status === 'ok'
              ? `Thresholds are ${CHAIN_TIP_WARN_BLOCK_TIMES} and ${CHAIN_TIP_FAIL_BLOCK_TIMES} times the ${seconds(blockTimeMs / 1000)}-second target block time; a node that follows the chain has a block at most a few block times old.`
              : 'The node is not adding blocks: it has stalled or fallen behind (its server, broker or database process may have stopped, or it lost its peers). Check the node services, their logs and the peer connections, and compare its height with other nodes; if they stopped at the same height, the network itself is stalled.',
        }),
      );
    } else {
      checks.push(
        cannotCheck(
          'chain_tip_age',
          !chain.ok
            ? chain.detail
            : latest?.ok === false
              ? failureText(host, `/blocks/${chain.value.height}`, latest.error)
              : `${host} answered /blocks/${chain.value.height} with a block timestamp that is not a valid time.`,
        ),
      );
    }

    if (!peers.ok) {
      remarks.push(`${failureText(host, '/node/peers', peers.error)} The peer count is unknown.`);
    }

    const verdict = deriveHealthVerdict(checks);
    // Synced up to the warn threshold of chain_tip_age; not judged when that check could not be made.
    const synced = tip === null ? null : tip.status === 'ok';

    // What the node says about itself is labelled and quoted; line 1 starts with the configured
    // host, so a friendlyName cannot read as the subject of the server's sentence.
    const reported = node
      ? [
          node.friendlyName ? labelledQuote('friendlyName', node.friendlyName) : null,
          node.host ? labelledQuote('host', node.host) : null,
        ].filter((part) => part !== null)
      : [];
    const syncText =
      synced === null
        ? '; whether it is synced could not be judged'
        : synced
          ? ' and synced'
          : ' and NOT synced';
    const facts = [
      node
        ? `Symbol ${node.version}, roles ${node.roles.join('/') || 'none'}`
        : 'Version and roles unknown',
      chain.ok
        ? `height ${formatInteger(chain.value.height)}, finalized ${formatInteger(chain.value.finalizedHeight)} (epoch ${chain.value.finalizationEpoch})`
        : 'height unknown',
      peers.ok
        ? `${formatInteger(peers.value.length)} peer${peers.value.length === 1 ? '' : 's'}`
        : 'peer count unknown',
      tip === null
        ? 'age of the latest block unknown'
        : `${
            tip.ageSeconds < 0
              ? `latest block timestamped ${formatInteger(-tip.ageSeconds)} s ahead of this machine's clock`
              : `latest block ${formatInteger(tip.ageSeconds)} s old`
          } (not synced above ${seconds(thresholds.warnSeconds)} s)`,
    ];
    const summary = [
      `${host}${reported.length > 0 ? ` (${reported.join(', ')})` : ''} on ${ctx.network.name} is ${verdict}${syncText}.`,
      `${facts.join('; ')}.`,
      ...checks
        .filter((c) => c.status !== 'ok')
        .map((c) => `- ${c.id} ${c.status}: ${summaryDetails.get(c.id) ?? c.detail}`),
      ...remarks.map((remark) => `- ${remark}`),
    ].join('\n');

    return {
      summary,
      verdict,
      sync: {
        synced,
        latestBlockTime: tip === null ? null : ctx.instant(tip.latestBlockDate),
        ageSeconds: tip === null ? null : tip.ageSeconds,
        thresholdSeconds: thresholds.warnSeconds,
        checkedAt: ctx.instant(now),
      },
      checks: stripOkHints(checks, format),
      node,
      network,
      chain: chain.ok ? chain.value : null,
      storage: storage.ok ? storage.value : null,
      peers: peers.ok ? { count: peers.value.length } : null,
      time: {
        nodeTime: clock === null ? null : ctx.instant(clock.nodeDate),
        localTime: ctx.instant(now),
        skewMs: clock === null ? null : clock.skewMs,
      },
      notes: [...NOTES, ...remarks],
    };
  },
});
