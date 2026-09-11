import { describe, expect, it } from 'vitest';
import {
  PropertyParseError,
  parseDurationMs,
  parseHexId,
  parseNetworkProperties,
  parsePropertyInt,
  parsePropertyNumber,
} from '../../src/domain/properties.js';
import { fixture } from '../tools/harness.js';

describe('parsePropertyInt', () => {
  it('strips apostrophe separators', () => {
    expect(parsePropertyInt("3'000'000'000'000")).toBe(3_000_000_000_000n);
    expect(parsePropertyInt("7'842'928'625'000'000")).toBe(7_842_928_625_000_000n);
  });
  it('accepts plain digits', () => {
    expect(parsePropertyInt('1440')).toBe(1440n);
    expect(parsePropertyNumber('3')).toBe(3);
  });
  it('rejects garbage', () => {
    expect(() => parsePropertyInt('30s')).toThrow(PropertyParseError);
    expect(() => parsePropertyInt('')).toThrow(PropertyParseError);
    expect(() => parsePropertyInt('0x10')).toThrow(PropertyParseError);
  });
});

describe('parseHexId', () => {
  it('handles the 0x + apostrophe form', () => {
    expect(parseHexId("0x6BED'913F'A202'23F8")).toBe('6BED913FA20223F8');
  });
  it('accepts plain 16-hex and upper-cases', () => {
    expect(parseHexId('6bed913fa20223f8')).toBe('6BED913FA20223F8');
  });
  it('rejects wrong lengths', () => {
    expect(() => parseHexId('0x6BED')).toThrow(PropertyParseError);
  });
});

describe('parseDurationMs', () => {
  it('parses each unit', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('6h')).toBe(21_600_000);
    expect(parseDurationMs('2d')).toBe(172_800_000);
  });
  it('parses the epochAdjustment form', () => {
    expect(parseDurationMs('1615853185s')).toBe(1_615_853_185_000);
  });
  it('rejects unit-less or unknown-unit values', () => {
    expect(() => parseDurationMs('30')).toThrow(PropertyParseError);
    expect(() => parseDurationMs('30w')).toThrow(PropertyParseError);
    expect(() => parseDurationMs('')).toThrow(PropertyParseError);
  });
});

describe('parseNetworkProperties', () => {
  it('parses the captured mainnet properties', () => {
    const props = parseNetworkProperties(fixture('mainnet/network-properties.json'));
    expect(props.identifier).toBe('mainnet');
    expect(props.generationHashSeed).toBe(
      '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6',
    );
    expect(props.epochAdjustmentSeconds).toBe(1_615_853_185);
    expect(props.currencyMosaicId).toBe('6BED913FA20223F8');
    expect(props.blockGenerationTargetTimeMs).toBe(30_000);
    expect(props.votingSetGrouping).toBe(1440);
    expect(props.importanceGrouping).toBe(720);
    expect(props.minVoterBalance).toBe(3_000_000_000_000n);
    expect(props.minHarvesterBalance).toBe(10_000_000_000n);
    expect(props.maxHarvesterBalance).toBe(50_000_000_000_000n);
    expect(props.maxVotingKeysPerAccount).toBe(3);
    expect(props.minVotingKeyLifetime).toBe(112);
    expect(props.maxVotingKeyLifetime).toBe(360);
    expect(props.harvestBeneficiaryPercentage).toBe(25);
    expect(props.harvestNetworkPercentage).toBe(5);
  });
  it('fails loudly when a property is missing', () => {
    const raw = fixture<{ network: Record<string, unknown>; chain: Record<string, unknown> }>(
      'mainnet/network-properties.json',
    );
    const { votingSetGrouping: _omit, ...chain } = raw.chain;
    expect(() => parseNetworkProperties({ network: raw.network, chain })).toThrow(
      /chain\.votingSetGrouping/,
    );
  });
});
