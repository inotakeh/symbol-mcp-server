/**
 * Parsers for `/network/properties`.
 *
 * catapult-rest returns every property as a string in its config-file form:
 *   - integers with apostrophe thousands separators: "3'000'000'000'000"
 *   - hex ids with a 0x prefix and apostrophes: "0x6BED'913F'A202'23F8"
 *   - durations with a unit suffix: "30s", "15m", "1h", "1d", "500ms"
 */

export class PropertyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyParseError';
  }
}

/** "3'000'000" -> 3000000n. Also accepts plain digit strings. */
export function parsePropertyInt(value: string): bigint {
  const cleaned = value.replace(/'/g, '').trim();
  if (!/^-?\d+$/.test(cleaned)) {
    throw new PropertyParseError(`not an integer property: ${JSON.stringify(value)}`);
  }
  return BigInt(cleaned);
}

/** Like parsePropertyInt but returns a safe JS number; throws if it does not fit. */
export function parsePropertyNumber(value: string): number {
  const big = parsePropertyInt(value);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new PropertyParseError(`integer property does not fit in a JS number: ${value}`);
  }
  return Number(big);
}

/** "0x6BED'913F'A202'23F8" -> "6BED913FA20223F8". Accepts plain 16-hex too. */
export function parseHexId(value: string): string {
  const cleaned = value.replace(/'/g, '').trim().replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(cleaned)) {
    throw new PropertyParseError(`not a 64-bit hex id property: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** "30s" -> 30000, "15m" -> 900000, "1615853185s" -> 1615853185000. Returns milliseconds. */
export function parseDurationMs(value: string): number {
  const match = /^\s*(\d+(?:'\d+)*)\s*(ms|s|m|h|d)\s*$/.exec(value);
  if (!match) {
    throw new PropertyParseError(`not a duration property: ${JSON.stringify(value)}`);
  }
  const amount = Number(match[1]?.replace(/'/g, ''));
  const unit = match[2] ?? 's';
  const factor = DURATION_UNITS_MS[unit];
  if (factor === undefined) {
    throw new PropertyParseError(`unknown duration unit in ${JSON.stringify(value)}`);
  }
  return amount * factor;
}

/** Typed subset of the network configuration that the tools need. */
export interface NetworkProperties {
  readonly identifier: string;
  readonly generationHashSeed: string;
  /** Seconds since the Unix epoch at which network time 0 starts. */
  readonly epochAdjustmentSeconds: number;
  readonly currencyMosaicId: string;
  readonly harvestingMosaicId: string;
  readonly blockGenerationTargetTimeMs: number;
  readonly votingSetGrouping: number;
  readonly importanceGrouping: number;
  readonly minHarvesterBalance: bigint;
  readonly maxHarvesterBalance: bigint;
  readonly minVoterBalance: bigint;
  readonly maxVotingKeysPerAccount: number;
  readonly minVotingKeyLifetime: number;
  readonly maxVotingKeyLifetime: number;
  readonly harvestBeneficiaryPercentage: number;
}

export interface RawNetworkProperties {
  readonly network: Readonly<Record<string, unknown>>;
  readonly chain: Readonly<Record<string, unknown>>;
}

function requireString(
  section: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const v = section[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new PropertyParseError(`missing or non-string property ${where}.${key}`);
  }
  return v;
}

export function parseNetworkProperties(raw: RawNetworkProperties): NetworkProperties {
  const net = (k: string) => requireString(raw.network, k, 'network');
  const chain = (k: string) => requireString(raw.chain, k, 'chain');
  return {
    identifier: net('identifier'),
    generationHashSeed: net('generationHashSeed').toUpperCase(),
    epochAdjustmentSeconds: Math.floor(parseDurationMs(net('epochAdjustment')) / 1000),
    currencyMosaicId: parseHexId(chain('currencyMosaicId')),
    harvestingMosaicId: parseHexId(chain('harvestingMosaicId')),
    blockGenerationTargetTimeMs: parseDurationMs(chain('blockGenerationTargetTime')),
    votingSetGrouping: parsePropertyNumber(chain('votingSetGrouping')),
    importanceGrouping: parsePropertyNumber(chain('importanceGrouping')),
    minHarvesterBalance: parsePropertyInt(chain('minHarvesterBalance')),
    maxHarvesterBalance: parsePropertyInt(chain('maxHarvesterBalance')),
    minVoterBalance: parsePropertyInt(chain('minVoterBalance')),
    maxVotingKeysPerAccount: parsePropertyNumber(chain('maxVotingKeysPerAccount')),
    minVotingKeyLifetime: parsePropertyNumber(chain('minVotingKeyLifetime')),
    maxVotingKeyLifetime: parsePropertyNumber(chain('maxVotingKeyLifetime')),
    harvestBeneficiaryPercentage: parsePropertyNumber(chain('harvestBeneficiaryPercentage')),
  };
}
