/**
 * Environment configuration and startup network verification.
 *
 * The node URL comes ONLY from the environment (never from tool arguments) so the model can
 * never point the server at an arbitrary host. See DESIGN-BRIEF §2-3 and §4.
 */
import type { RestClient } from './client/rest.js';
import { NodeInfoSchema } from './client/schemas.js';
import { findNetworkBySeed, isNetworkName, type NetworkName } from './domain/network.js';
import { isValidTimeZone } from './domain/time.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class NetworkVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkVerificationError';
  }
}

export interface Config {
  readonly nodeUrl: string;
  readonly expectedNetwork: NetworkName | undefined;
  readonly timeZone: string | undefined;
  readonly referenceNodes: readonly string[];
  readonly requestTimeoutMs: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Accepts https URLs; http only for loopback. Strips trailing slashes, keeps the port as given. */
export function validateNodeUrl(raw: string, label = 'SYMBOL_NODE_URL'): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`${label} is not a valid URL: ${JSON.stringify(trimmed)}`);
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new ConfigError(
        `${label} must use https:// (http:// is only allowed for localhost / 127.0.0.1)`,
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new ConfigError(`${label} must start with https://`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${label} must not contain credentials`);
  }
  if (url.search || url.hash) {
    throw new ConfigError(`${label} must not contain a query string or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const rawNodeUrl = env.SYMBOL_NODE_URL;
  if (!rawNodeUrl || rawNodeUrl.trim() === '') {
    throw new ConfigError(
      'SYMBOL_NODE_URL is required, e.g. SYMBOL_NODE_URL=https://<node-host>:3001',
    );
  }
  const nodeUrl = validateNodeUrl(rawNodeUrl);

  let expectedNetwork: NetworkName | undefined;
  const rawNetwork = env.SYMBOL_NETWORK?.trim().toLowerCase();
  if (rawNetwork) {
    if (!isNetworkName(rawNetwork)) {
      throw new ConfigError(`SYMBOL_NETWORK must be "mainnet" or "testnet", got "${rawNetwork}"`);
    }
    expectedNetwork = rawNetwork;
  }

  let timeZone: string | undefined;
  const rawTz = env.SYMBOL_TIMEZONE?.trim();
  if (rawTz) {
    if (!isValidTimeZone(rawTz)) {
      throw new ConfigError(`SYMBOL_TIMEZONE is not a valid IANA time zone: "${rawTz}"`);
    }
    timeZone = rawTz;
  }

  const referenceNodes = (env.SYMBOL_REFERENCE_NODES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => validateNodeUrl(s, 'SYMBOL_REFERENCE_NODES entry'));

  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const rawTimeout = env.SYMBOL_REQUEST_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n < 100 || n > 600_000) {
      throw new ConfigError('SYMBOL_REQUEST_TIMEOUT_MS must be an integer between 100 and 600000');
    }
    requestTimeoutMs = n;
  }

  return { nodeUrl, expectedNetwork, timeZone, referenceNodes, requestTimeoutMs };
}

export interface ResolvedNetwork {
  readonly name: NetworkName;
  readonly identifier: number;
  readonly generationHashSeed: string;
  /** Host name the node reports about itself (untrusted, informational). */
  readonly nodeHost: string;
}

/**
 * Fetches `/node/info`, maps the generation hash seed to a known network and checks it against
 * SYMBOL_NETWORK when set. Throws NetworkVerificationError on mismatch so startup fails loudly
 * instead of silently talking to the wrong chain.
 */
export async function resolveNetwork(rest: RestClient, config: Config): Promise<ResolvedNetwork> {
  const info = await rest.get('/node/info', NodeInfoSchema);
  const known = findNetworkBySeed(info.networkGenerationHashSeed);
  if (!known) {
    throw new NetworkVerificationError(
      `Node ${rest.host} reports an unknown network (identifier ${info.networkIdentifier}, generation hash seed ${info.networkGenerationHashSeed}). Only Symbol mainnet and testnet are supported.`,
    );
  }
  if (config.expectedNetwork && config.expectedNetwork !== known.name) {
    throw new NetworkVerificationError(
      `SYMBOL_NETWORK=${config.expectedNetwork} but node ${rest.host} is on ${known.name}. Fix SYMBOL_NODE_URL or SYMBOL_NETWORK; the server refuses to start on a mismatched network.`,
    );
  }
  return {
    name: known.name,
    identifier: known.identifier,
    generationHashSeed: known.generationHashSeed,
    nodeHost: info.host ?? rest.host,
  };
}
