import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import {
  ChainInfoSchema,
  NodeHealthSchema,
  NodeInfoSchema,
  NodeStorageSchema,
  NodeTimeSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import type { DiagnoseCheck } from '../domain/delegation.js';
import { parseHeight } from '../domain/epoch.js';
import {
  assessClockSkew,
  assessFinalizationLag,
  assessStorage,
  computeClockSkewMs,
  deriveHealthVerdict,
  type HealthVerdict,
  pickNodeTimestamp,
  serviceStatus,
  skewThresholds,
} from '../domain/nodehealth.js';
import { decodeRoles } from '../domain/roles.js';
import { networkTimestampToDate } from '../domain/time.js';
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
  network: z.string(),
  verdict: z.enum(['healthy', 'degraded', 'unhealthy']),
  checks: z.array(CheckSchema),
  node: nullable(
    z.object({ version: z.string(), roles: z.array(z.string()), publicKey: z.string() }),
    'Version, roles and public key from /node/info; null when that request failed.',
  ),
  storage: nullable(
    z.object({ numBlocks: z.number(), numTransactions: z.number(), numAccounts: z.number() }),
    'Counts the node reports from its own database (/node/storage); null when that request failed.',
  ),
  chain: nullable(
    z.object({ height: z.number(), finalizedHeight: z.number(), finalizationEpoch: z.number() }),
    'From /chain/info; null when that request failed.',
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

const VERDICT_TEXT: Record<HealthVerdict, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  unhealthy: 'unhealthy',
};

const NOTES = [
  'clock_skew compares the node clock with the clock of the machine running this server (including request latency); the local clock may be the one that is off.',
  'storage counts come from the node database as reported by the node and are not backed by chain data.',
  'Thresholds are derived from the network: one minute of blocks for storage, half and one block time for clock skew, half and one epoch (votingSetGrouping blocks) for finalization lag.',
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

function failureText(host: string, path: string, error: RestError): string {
  return `${host} did not answer ${path} (${error.kind}${error.status ? ` ${error.status}` : ''}).`;
}

function buildSummary(
  host: string,
  network: string,
  verdict: HealthVerdict,
  checks: readonly DiagnoseCheck[],
): string {
  const lines = [`node health: ${VERDICT_TEXT[verdict]} (${host}, ${network}).`];
  for (const c of checks) {
    if (c.status !== 'ok') lines.push(`- ${c.id} ${c.status}: ${c.detail}`);
  }
  return lines.join('\n');
}

export const nodeHealthTool = defineTool({
  name: 'symbol_node_health',
  title: 'Symbol node health',
  description:
    'Check whether the services of the configured Symbol node (SYMBOL_NODE_URL) are running healthily right now: API node, database, storage, clock and finalization lag, as one verdict. For whether the node is in sync, its version and its peer count, use symbol_node_status; for whether its version is behind the network, symbol_version_drift; for how many blocks it trails other nodes, symbol_network_compare. Six checks in a fixed order, each ok/warn/fail/unknown with a hint: API node and database status from /node/health (a 503 answer is read, not treated as a failure), node database block count versus chain height, node clock versus the local clock, finalization lag in blocks and minutes, and the node roles (is it a voting node). The verdict is healthy, degraded (a warning, or a check that could not be made) or unhealthy. Thresholds come from the network properties.',
  inputSchema,
  outputSchema,
  untrustedText: true,
  run: async (ctx: AppContext, { format }, text) => {
    const host = ctx.rest.host;
    const [{ properties }, health, storage, time, chain, info] = await Promise.all([
      ctx.getNetworkData(),
      settle(
        ctx.rest.get('/node/health', NodeHealthSchema, {
          acceptStatuses: HEALTH_ACCEPTED_STATUSES,
        }),
      ),
      settle(ctx.rest.get('/node/storage', NodeStorageSchema)),
      settle(ctx.rest.get('/node/time', NodeTimeSchema)),
      settle(ctx.rest.get('/chain/info', ChainInfoSchema)),
      settle(ctx.rest.get('/node/info', NodeInfoSchema)),
    ]);
    const now = ctx.now();
    const blockTimeMs = properties.blockGenerationTargetTimeMs;
    const checks: DiagnoseCheck[] = [];

    // 1-2. api_node, db
    if (health.ok) {
      const apiNode = serviceStatus(health.value.status.apiNode, text);
      const db = serviceStatus(health.value.status.db, text);
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
    const height = chain.ok ? parseHeight(chain.value.height) : null;
    if (storage.ok && height !== null) {
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
    } else {
      checks.push(
        check({
          id: 'storage_consistent',
          status: 'unknown',
          detail: !storage.ok
            ? failureText(host, '/node/storage', storage.error)
            : failureText(host, '/chain/info', (chain as { error: RestError }).error),
          hint: 'Retry later; the other checks do not depend on it.',
        }),
      );
    }

    // 4. clock_skew
    const nodeTimestamp = time.ok ? pickNodeTimestamp(time.value.communicationTimestamps) : null;
    let nodeTime: Output['time']['nodeTime'] = null;
    let skewMs: number | null = null;
    if (time.ok && nodeTimestamp !== null) {
      const nodeDate = networkTimestampToDate(nodeTimestamp, properties.epochAdjustmentSeconds);
      nodeTime = ctx.instant(nodeDate);
      skewMs = computeClockSkewMs(nodeTimestamp, properties.epochAdjustmentSeconds, now);
      const status = assessClockSkew(skewMs, blockTimeMs);
      const { warnMs, failMs } = skewThresholds(blockTimeMs);
      const direction = skewMs >= 0 ? 'ahead of' : 'behind';
      checks.push(
        check({
          id: 'clock_skew',
          status,
          detail: `Node clock is ${formatInteger(Math.abs(skewMs))} ms ${direction} this machine's clock (warn at ${formatInteger(warnMs)} ms, fail at ${formatInteger(failMs)} ms).`,
          hint:
            status === 'ok'
              ? 'Within half a block time; harvesting and transaction deadlines are unaffected.'
              : 'A node clock off by a block time or more makes harvested blocks and announced transactions fail their time checks. Enable NTP/chrony on the node host (and on this machine, which may be the one that is off) and re-check.',
        }),
      );
    } else {
      checks.push(
        check({
          id: 'clock_skew',
          status: 'unknown',
          detail: time.ok
            ? `${host} answered /node/time without a timestamp.`
            : failureText(host, '/node/time', time.error),
          hint: 'Retry later; the other checks do not depend on it.',
        }),
      );
    }

    // 5. finalization_lag
    if (chain.ok && height !== null) {
      const finalized = parseHeight(chain.value.latestFinalizedBlock.height);
      const lag = assessFinalizationLag(
        height,
        finalized,
        properties.votingSetGrouping,
        blockTimeMs,
      );
      checks.push(
        check({
          id: 'finalization_lag',
          status: lag.status,
          detail: `Finalized height ${formatInteger(finalized)} is ${formatInteger(lag.lagBlocks)} blocks (about ${lag.lagMinutes} min) behind height ${formatInteger(height)} (warn at ${formatInteger(lag.warnBlocks)}, fail at ${formatInteger(lag.failBlocks)} blocks).`,
          hint:
            lag.status === 'ok'
              ? 'Less than half an epoch behind is normal finalization progress.'
              : 'Finalization has fallen behind by half an epoch or more. If reference nodes agree, the network is finalizing slowly; if only this node lags, it is not receiving finalization messages (check peers and the voting configuration).',
        }),
      );
    } else {
      checks.push(
        check({
          id: 'finalization_lag',
          status: 'unknown',
          detail: failureText(host, '/chain/info', (chain as { error: RestError }).error),
          hint: 'Retry later; the other checks do not depend on it.',
        }),
      );
    }

    // 6. roles
    let node: Output['node'] = null;
    if (info.ok) {
      const roles = decodeRoles(info.value.roles);
      node = { version: decodeVersion(info.value.version), roles, publicKey: info.value.publicKey };
      checks.push(
        check({
          id: 'roles',
          status: 'ok',
          detail: `Roles ${roles.join('/') || 'none'} (${roles.includes('Voting') ? 'a voting node' : 'not a voting node'}).`,
          hint: 'Informational: decoded from the roles bit flags of /node/info.',
        }),
      );
    } else {
      checks.push(
        check({
          id: 'roles',
          status: 'unknown',
          detail: failureText(host, '/node/info', info.error),
          hint: 'Retry later; the other checks do not depend on it.',
        }),
      );
    }

    const verdict = deriveHealthVerdict(checks);
    return {
      summary: buildSummary(host, ctx.network.name, verdict, checks),
      network: ctx.network.name,
      verdict,
      checks: stripOkHints(checks, format),
      node,
      storage: storage.ok ? storage.value : null,
      chain:
        chain.ok && height !== null
          ? {
              height,
              finalizedHeight: parseHeight(chain.value.latestFinalizedBlock.height),
              finalizationEpoch: chain.value.latestFinalizedBlock.finalizationEpoch,
            }
          : null,
      time: { nodeTime, localTime: ctx.instant(now), skewMs },
      notes: [...NOTES],
    };
  },
});
