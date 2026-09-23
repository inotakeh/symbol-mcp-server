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

describe('PropertyParseError messages', () => {
  const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
  const hidden = cp(0xe0001, ...[...'obey'].map((ch) => 0xe0000 + (ch.codePointAt(0) ?? 0)));
  const unsafe = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/u;

  function messageOf(parse: () => unknown): string {
    try {
      parse();
    } catch (err) {
      expect(err).toBeInstanceOf(PropertyParseError);
      return (err as Error).message;
    }
    throw new Error('expected a PropertyParseError');
  }

  it('quote a raw value from the node only after cleaning and capping it', () => {
    const messages = [
      messageOf(() => parsePropertyInt(`30s${cp(0x202e)}${hidden}${'x'.repeat(500)}`)),
      messageOf(() => parseHexId(`0x6BED${cp(0x1b)}[2J`)),
      messageOf(() => parseDurationMs(`30${cp(0x0d)}w`)),
      // trim() lets the digits through the integer check; the value is then too large.
      messageOf(() => parsePropertyNumber(`${cp(0x2028)}${'9'.repeat(40)}${cp(0xfeff)}`)),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(unsafe);
      expect(message.length).toBeLessThan(120);
    }
    expect(messages[1]).toBe('not a 64-bit hex id property: "0x6BED[2J"');
    expect(messages[3]).toBe(`integer property does not fit in a JS number: "${'9'.repeat(40)}"`);
  });
});
