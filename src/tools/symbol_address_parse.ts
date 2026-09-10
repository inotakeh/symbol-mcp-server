import * as z from 'zod/v4';
import {
  base32AddressToHex,
  classifyAccountId,
  hexAddressToBase32,
  networkIdentifierOfAddress,
  publicKeyToAddress,
} from '../domain/address.js';
import { findNetworkByIdentifier, KNOWN_NETWORKS } from '../domain/network.js';
import { defineTool, maskIdentifier, nullable } from './_shared.js';

const inputSchema = z.object({
  value: z
    .string()
    .min(1)
    .describe(
      'Value to parse: a base32 address (39 chars, dashes allowed), a hex address (48 chars) or a public key (64 hex chars).',
    ),
});

const NetworkSchema = z.object({
  name: z.string(),
  identifier: z.number(),
  matchesConfiguredNetwork: z.boolean(),
});

const outputSchema = z.object({
  summary: z.string(),
  valid: z.boolean(),
  kind: z.enum(['address', 'hexAddress', 'publicKey', 'invalid']),
  reason: nullable(z.string(), 'Why the value is invalid; null when valid.'),
  address: nullable(
    z.object({ base32: z.string(), hex: z.string(), pretty: z.string() }),
    'The address in every form; null when invalid. For a public key: the address on the configured network.',
  ),
  network: nullable(NetworkSchema, 'Network encoded in the address; null when invalid.'),
  publicKey: nullable(z.string(), 'Upper-case public key when the input was one; null otherwise.'),
  derivedAddresses: nullable(
    z.array(z.object({ network: z.string(), identifier: z.number(), base32: z.string() })),
    'For a public key: its address on every known network; null otherwise.',
  ),
  configuredNetwork: z.string(),
});

function pretty(base32: string): string {
  return base32.match(/.{1,6}/g)?.join('-') ?? base32;
}

function networkOf(base32: string, configured: string) {
  const identifier = networkIdentifierOfAddress(base32);
  const known = findNetworkByIdentifier(identifier);
  const name = known?.name ?? 'unknown';
  return { name, identifier, matchesConfiguredNetwork: name === configured };
}

export const addressParseTool = defineTool({
  name: 'symbol_address_parse',
  title: 'Symbol address parser',
  description:
    'Validate and convert a Symbol address or public key without contacting the node: reports whether the value is a valid base32 address, hex address or public key, gives the address in base32, hex and dashed form, the network encoded in it (N = mainnet, T = testnet) and whether that matches the configured node, and for a public key the derived address on every known network.',
  inputSchema,
  outputSchema,
  run: async (ctx, { value }) => {
    const configured = ctx.network.name;
    const classified = classifyAccountId(value);

    if (classified.kind === 'invalid') {
      const trimmed = value.trim().replace(/-/g, '');
      const reason =
        trimmed.length === 0
          ? 'Empty input.'
          : /^[0-9A-Fa-f]+$/.test(trimmed)
            ? `Hex input must be 48 characters (address) or 64 characters (public key); got ${trimmed.length}.`
            : trimmed.length === 39
              ? 'Looks like a base32 address but the checksum does not match; check for typos (base32 uses A-Z and 2-7 only).'
              : `A base32 address has 39 characters; got ${trimmed.length}.`;
      return {
        summary: `"${maskIdentifier(value.trim())}" is not a valid Symbol address or public key. ${reason}`,
        valid: false,
        kind: 'invalid' as const,
        reason,
        address: null,
        network: null,
        publicKey: null,
        derivedAddresses: null,
        configuredNetwork: configured,
      };
    }

    if (classified.kind === 'publicKey') {
      const publicKey = classified.canonical;
      const derivedAddresses = KNOWN_NETWORKS.map((n) => ({
        network: n.name,
        identifier: n.identifier,
        base32: publicKeyToAddress(publicKey, n.identifier),
      }));
      const base32 = publicKeyToAddress(publicKey, ctx.network.identifier);
      return {
        summary: `${maskIdentifier(publicKey)} is a public key. Its address on ${configured} is ${base32} (${derivedAddresses.map((d) => `${d.network}: ${d.base32}`).join(', ')}).`,
        valid: true,
        kind: 'publicKey' as const,
        reason: null,
        address: { base32, hex: base32AddressToHex(base32), pretty: pretty(base32) },
        network: networkOf(base32, configured),
        publicKey,
        derivedAddresses,
        configuredNetwork: configured,
      };
    }

    const base32 = classified.canonical;
    const hex =
      classified.kind === 'hexAddress' ? value.trim().toUpperCase() : base32AddressToHex(base32);
    const network = networkOf(base32, configured);
    return {
      summary: `${base32} is a valid ${network.name} address (hex ${hex})${network.matchesConfiguredNetwork ? '' : `; note the configured node is on ${configured}`}.`,
      valid: true,
      kind: classified.kind,
      reason: null,
      address: { base32: hexAddressToBase32(hex), hex, pretty: pretty(base32) },
      network,
      publicKey: null,
      derivedAddresses: null,
      configuredNetwork: configured,
    };
  },
});
