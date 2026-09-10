/**
 * Known Symbol networks, identified by their generation hash seed.
 *
 * This table is the ONLY network constant that is hard-coded (see DESIGN-BRIEF §2-5, §4).
 * Everything else (epochAdjustment, votingSetGrouping, mosaic ids, ...) is read from
 * `/network/properties` at runtime.
 */
export type NetworkName = 'mainnet' | 'testnet';

export interface KnownNetwork {
  readonly name: NetworkName;
  readonly identifier: number;
  readonly generationHashSeed: string;
}

export const KNOWN_NETWORKS: readonly KnownNetwork[] = [
  {
    name: 'mainnet',
    identifier: 104,
    generationHashSeed: '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6',
  },
  {
    name: 'testnet',
    identifier: 152,
    generationHashSeed: '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4',
  },
];

export function findNetworkBySeed(generationHashSeed: string): KnownNetwork | undefined {
  const seed = generationHashSeed.toUpperCase();
  return KNOWN_NETWORKS.find((n) => n.generationHashSeed === seed);
}

export function findNetworkByIdentifier(identifier: number): KnownNetwork | undefined {
  return KNOWN_NETWORKS.find((n) => n.identifier === identifier);
}

export function isNetworkName(value: string): value is NetworkName {
  return value === 'mainnet' || value === 'testnet';
}
