/**
 * Per-process application context shared by all tools: configuration, the REST client, the
 * verified network, and the one thing we cache (network properties + currency metadata).
 */
import { RestClient } from './client/rest.js';
import {
  BlockInfoSchema,
  MosaicInfoSchema,
  MosaicNamesSchema,
  NamespaceNamesSchema,
  NetworkPropertiesRawSchema,
} from './client/schemas.js';
import type { Config, ResolvedNetwork } from './config.js';
import { type NetworkProperties, parseNetworkProperties } from './domain/properties.js';
import { sanitizeUntrusted } from './domain/sanitize.js';
import { formatInstant, type Instant } from './domain/time.js';

export interface CurrencyInfo {
  readonly mosaicId: string;
  /** Namespace alias such as "symbol.xym" (untrusted, sanitized) or null when none is set. */
  readonly alias: string | null;
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

export class AppContext {
  private networkDataPromise: Promise<NetworkData> | undefined;
  private referenceClientList: RestClient[] | undefined;

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

  /** Resolves mosaic ids to their first alias name via `POST /namespaces/mosaic/names`. */
  async resolveMosaicAliases(mosaicIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (mosaicIds.length === 0) return out;
    const res = await this.rest.post('/namespaces/mosaic/names', { mosaicIds }, MosaicNamesSchema);
    for (const entry of res.mosaicNames) {
      const first = entry.names[0];
      if (first) out.set(entry.mosaicId.toUpperCase(), sanitizeUntrusted(first, 128));
    }
    return out;
  }

  /**
   * Resolves namespace ids to their full dotted names ("symbol.xym") via `POST /namespaces/names`.
   * The response lists parents alongside children; names are chained through `parentId`.
   */
  async resolveNamespaceNames(namespaceIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (namespaceIds.length === 0) return out;
    const entries = await this.rest.post(
      '/namespaces/names',
      { namespaceIds: [...namespaceIds] },
      NamespaceNamesSchema,
    );
    const byId = new Map<string, { name: string; parentId: string | undefined }>();
    for (const e of entries) {
      byId.set(e.id.toUpperCase(), {
        name: sanitizeUntrusted(e.name, 64),
        parentId: e.parentId?.toUpperCase(),
      });
    }
    const fullName = (id: string, depth: number): string | undefined => {
      const entry = byId.get(id);
      if (!entry || depth > 3) return undefined;
      if (!entry.parentId) return entry.name;
      const parent = fullName(entry.parentId, depth + 1);
      return parent ? `${parent}.${entry.name}` : entry.name;
    };
    for (const id of byId.keys()) {
      const name = fullName(id, 0);
      if (name) out.set(id, name);
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
