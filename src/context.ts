/**
 * Per-process application context shared by all tools: configuration, the REST client, the
 * verified network, and what we cache: network properties + currency metadata (once per
 * process) and namespace lookups for account arguments (one block time; see getNamespaceInfo).
 */
import { RestClient } from './client/rest.js';
import {
  BlockInfoSchema,
  MosaicInfoSchema,
  MosaicNamesSchema,
  type NamespaceInfo,
  NamespaceInfoSchema,
  NamespaceNamesSchema,
  NetworkPropertiesRawSchema,
} from './client/schemas.js';
import { type Config, loadConfig, type ResolvedNetwork, resolveNetwork } from './config.js';
import { type NetworkProperties, parseNetworkProperties } from './domain/properties.js';
import { type CleanedText, cleanUntrusted, joinCleaned } from './domain/sanitize.js';
import { formatInstant, type Instant } from './domain/time.js';

export interface CurrencyInfo {
  readonly mosaicId: string;
  /**
   * Namespace alias such as "symbol.xym" or null when none is set. Untrusted and cleaned once
   * per process; a tool that shows it passes it through its call's UntrustedText (`use`).
   */
  readonly alias: CleanedText | null;
  readonly divisibility: number;
}

export interface NetworkData {
  readonly properties: NetworkProperties;
  readonly currency: CurrencyInfo;
}

export interface AverageBlockTime {
  readonly averageBlockTimeMs: number;
  readonly sampleBlocks: number;
  readonly fromHeight: number;
  readonly toHeight: number;
}

export const DEFAULT_BLOCK_TIME_SAMPLE = 10_000;

interface CachedNamespace {
  readonly info: NamespaceInfo | null;
  readonly expiresAtMs: number;
}

export class AppContext {
  private networkDataPromise: Promise<NetworkData> | undefined;
  private referenceClientList: RestClient[] | undefined;
  private readonly namespaceCache = new Map<string, CachedNamespace>();

  constructor(
    readonly config: Config,
    readonly rest: RestClient,
    readonly network: ResolvedNetwork,
    readonly serverVersion: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  now(): Date {
    return this.clock();
  }

  instant(date: Date): Instant {
    return formatInstant(date, this.config.timeZone);
  }

  /**
   * One client per SYMBOL_REFERENCE_NODES entry (validated at startup), built lazily with the same
   * hygiene settings as the main client. This is the ONLY way tools may reach another host.
   */
  referenceClients(): readonly RestClient[] {
    if (!this.referenceClientList) {
      this.referenceClientList = this.config.referenceNodes.map(
        (baseUrl) =>
          new RestClient({
            baseUrl,
            timeoutMs: this.rest.timeoutMs,
            userAgent: this.rest.userAgent,
          }),
      );
    }
    return this.referenceClientList;
  }

  /** `/network/properties` (+ currency divisibility and alias) fetched once per process. */
  getNetworkData(): Promise<NetworkData> {
    if (!this.networkDataPromise) {
      this.networkDataPromise = this.loadNetworkData().catch((err) => {
        // Do not cache failures; the next call retries.
        this.networkDataPromise = undefined;
        throw err;
      });
    }
    return this.networkDataPromise;
  }

  private async loadNetworkData(): Promise<NetworkData> {
    const raw = await this.rest.get('/network/properties', NetworkPropertiesRawSchema);
    const properties = parseNetworkProperties(raw);
    const [mosaic, names] = await Promise.all([
      this.rest.get(`/mosaics/${properties.currencyMosaicId}`, MosaicInfoSchema),
      this.resolveMosaicAliases([properties.currencyMosaicId]),
    ]);
    return {
      properties,
      currency: {
        mosaicId: properties.currencyMosaicId,
        alias: names.get(properties.currencyMosaicId) ?? null,
        divisibility: mosaic.mosaic.divisibility,
      },
    };
  }

  /**
   * `GET /namespaces/{id}` (null on 404) cached per process for one blockGenerationTargetTime,
   * the shortest interval in which an alias can change on chain. Used to resolve account
   * arguments given as namespace names; the TTL comes from /network/properties, not a constant.
   */
  async getNamespaceInfo(namespaceId: string): Promise<NamespaceInfo | null> {
    const id = namespaceId.toUpperCase();
    const nowMs = this.now().getTime();
    const cached = this.namespaceCache.get(id);
    if (cached && cached.expiresAtMs > nowMs) return cached.info;
    const [{ properties }, info] = await Promise.all([
      this.getNetworkData(),
      this.rest.getOrNull(`/namespaces/${id}`, NamespaceInfoSchema),
    ]);
    this.namespaceCache.set(id, {
      info,
      expiresAtMs: nowMs + properties.blockGenerationTargetTimeMs,
    });
    return info;
  }

  /**
   * Resolves mosaic ids to their first alias name via `POST /namespaces/mosaic/names`. The names
   * are untrusted and come back cleaned; a tool shows them through its call's UntrustedText.
   */
  async resolveMosaicAliases(mosaicIds: readonly string[]): Promise<Map<string, CleanedText>> {
    const out = new Map<string, CleanedText>();
    if (mosaicIds.length === 0) return out;
    const res = await this.rest.post('/namespaces/mosaic/names', { mosaicIds }, MosaicNamesSchema);
    for (const entry of res.mosaicNames) {
      const first = entry.names[0];
      const id = entry.mosaicId.toUpperCase();
      if (first) out.set(id, cleanUntrusted(first, 128, `mosaic-alias:${id}`));
    }
    return out;
  }

  /**
   * Resolves namespace ids to their full dotted names ("symbol.xym") via `POST /namespaces/names`.
   * The response lists parents alongside children; names are chained through `parentId`. Each
   * level is keyed by its namespace id, so a parent shared by several names, or fetched twice in
   * one call, is counted once per call.
   */
  async resolveNamespaceNames(namespaceIds: readonly string[]): Promise<Map<string, CleanedText>> {
    const out = new Map<string, CleanedText>();
    if (namespaceIds.length === 0) return out;
    const entries = await this.rest.post(
      '/namespaces/names',
      { namespaceIds: [...namespaceIds] },
      NamespaceNamesSchema,
    );
    const byId = new Map<string, { name: CleanedText; parentId: string | undefined }>();
    for (const e of entries) {
      const id = e.id.toUpperCase();
      byId.set(id, {
        name: cleanUntrusted(e.name, 64, `namespace:${id}`),
        parentId: e.parentId?.toUpperCase(),
      });
    }
    /** The levels of a name, root first. */
    const levels = (id: string, depth: number): CleanedText[] | undefined => {
      const entry = byId.get(id);
      if (!entry || depth > 3) return undefined;
      if (!entry.parentId) return [entry.name];
      const parent = levels(entry.parentId, depth + 1);
      return parent ? [...parent, entry.name] : [entry.name];
    };
    for (const id of byId.keys()) {
      const name = levels(id, 0);
      if (name) out.set(id, joinCleaned(name, '.'));
    }
    return out;
  }

  /**
   * Measured average block time over the last `sample` blocks (two block fetches). Used for
   * future date estimates instead of the nominal blockGenerationTargetTime.
   */
  async getAverageBlockTime(
    currentHeight: number,
    sample: number = DEFAULT_BLOCK_TIME_SAMPLE,
  ): Promise<AverageBlockTime> {
    const toHeight = currentHeight;
    const fromHeight = Math.max(1, currentHeight - sample);
    const [from, to] = await Promise.all([
      this.rest.get(`/blocks/${fromHeight}`, BlockInfoSchema),
      this.rest.get(`/blocks/${toHeight}`, BlockInfoSchema),
    ]);
    const span = toHeight - fromHeight;
    const deltaMs = Number(to.block.timestamp) - Number(from.block.timestamp);
    const { properties } = await this.getNetworkData();
    const averageBlockTimeMs =
      span > 0 && deltaMs > 0 ? deltaMs / span : properties.blockGenerationTargetTimeMs;
    return { averageBlockTimeMs, sampleBlocks: span, fromHeight, toHeight };
  }
}

/**
 * Start-up sequence shared by the MCP server and the CLI check: read the environment, build the
 * REST client, verify the node's network. Throws ConfigError, NetworkVerificationError or
 * RestError; the caller decides how to report them.
 */
export async function createAppContext(
  env: Readonly<Record<string, string | undefined>>,
  serverName: string,
  version: string,
  clock?: () => Date,
): Promise<AppContext> {
  const config = loadConfig(env);
  const rest = new RestClient({
    baseUrl: config.nodeUrl,
    timeoutMs: config.requestTimeoutMs,
    userAgent: `${serverName}/${version}`,
  });
  const network = await resolveNetwork(rest, config);
  return new AppContext(config, rest, network, version, clock);
}
