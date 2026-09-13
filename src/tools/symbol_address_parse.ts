import * as z from 'zod/v4';
import {
  base32AddressToHex,
  classifyAccountId,
  hexAddressToBase32,
  networkIdentifierOfAddress,
  publicKeyToAddress,
} from '../domain/address.js';
import { findNetworkByIdentifier, KNOWN_NETWORKS } from '../domain/network.js';
import { AccountResolutionSchema, resolveAccountInput } from './_accounts.js';
import { defineTool, maskIdentifier, nullable } from './_shared.js';

const inputSchema = z.object({
  value: z
    .string()
    .min(1)
    .describe(
      'Value to parse: a base32 address (39 chars, dashes allowed), a hex address (48 chars), a public key (64 hex chars), or a namespace name with an address alias (e.g. alice, alice.pay; the only form that contacts the node).',
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
  kind: z.enum(['address', 'hexAddress', 'publicKey', 'namespace', 'invalid']),
  reason: nullable(z.string(), 'Why the value is invalid; null when valid.'),
  address: nullable(
    z.object({ base32: z.string(), hex: z.string(), pretty: z.string() }),
    'The address in every form; null when invalid. For a public key: the address on the configured network. For a namespace: the aliased address.',
  ),
  network: nullable(NetworkSchema, 'Network encoded in the address; null when invalid.'),
  publicKey: nullable(z.string(), 'Upper-case public key when the input was one; null otherwise.'),
  derivedAddresses: nullable(
    z.array(z.object({ network: z.string(), identifier: z.number(), base32: z.string() })),
    'For a public key: its address on every known network; null otherwise.',
  ),
  accountResolution: AccountResolutionSchema,
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
    'Validate and convert a Symbol address or public key: reports whether the value is a valid base32 address, hex address or public key, gives the address in base32, hex and dashed form, the network encoded in it (N = mainnet, T = testnet) and whether that matches the configured node, and for a public key the derived address on every known network. Addresses and keys are checked offline; a namespace name (alice, alice.pay) is resolved through the node to its address alias and reported with the namespace id in accountResolution.',
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
              ? 'Looks like a base32 address but the checksum does not match; check for typos (base32 uses A-Z and 2-7 only). Namespace names are lower-case.'
              : `A base32 address has 39 characters; got ${trimmed.length}. A namespace name uses lower-case letters, digits, - and _ in up to three dot-separated levels.`;
      return {
        summary: `"${maskIdentifier(value.trim())}" is not a valid Symbol address, public key or namespace name. ${reason}`,
        valid: false,
        kind: 'invalid' as const,
        reason,
        address: null,
        network: null,
        publicKey: null,
        derivedAddresses: null,
        accountResolution: null,
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
        accountResolution: null,
        configuredNetwork: configured,
      };
    }

    if (classified.kind === 'namespace') {
      // The only branch that talks to the node: resolves the alias (errors carry hints).
      const { resolution } = await resolveAccountInput(ctx, value);
      const base32 = resolution?.address ?? classified.canonical;
      const hex = base32AddressToHex(base32);
      const network = networkOf(base32, configured);
      return {
        summary: `${resolution?.namespace ?? classified.canonical} → ${base32}. Namespace ${resolution?.namespaceId ?? ''} aliases the ${network.name} address ${base32} (hex ${hex})${network.matchesConfiguredNetwork ? '' : `; note the configured node is on ${configured}`}.`,
        valid: true,
        kind: 'namespace' as const,
        reason: null,
        address: { base32, hex, pretty: pretty(base32) },
        network,
        publicKey: null,
        derivedAddresses: null,
        accountResolution: resolution,
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
      accountResolution: null,
      configuredNetwork: configured,
    };
  },
});
