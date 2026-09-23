import * as z from 'zod/v4';
import { MosaicInfoSchema, UnlockedAccountSchema } from '../client/schemas.js';
import { hexAddressToBase32 } from '../domain/address.js';
import { formatAmount } from '../domain/amount.js';
import { classifyHarvesterBalance, type HarvesterBalance } from '../domain/delegation.js';
import {
  type AccountResolution,
  AccountResolutionSchema,
  withResolutionPrefix,
} from './_accounts.js';
import { defineTool, formatInteger, nullable } from './_shared.js';
import { fetchAccount } from './symbol_account_get.js';

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional harvester account to check: base32 address (39 chars), hex public key (64 chars), or a namespace name with an address alias (e.g. alice, alice.pay; resolved through the node). When given, reports whether its linked (remote) key is unlocked on this node and whether its balance is within the harvesting limits.',
    ),
});

const AccountReportSchema = z.object({
  address: z.string(),
  publicKey: nullable(z.string(), 'Main public key; null until the account has transacted.'),
  linkedPublicKey: nullable(z.string(), 'Remote (linked) harvesting key; null when not linked.'),
  vrfPublicKey: nullable(z.string(), 'VRF key; null when not set.'),
  nodePublicKey: nullable(z.string(), 'Node key the account delegated to; null when not set.'),
  delegatedHarvestingConfigured: z.boolean(),
  unlockedOnThisNode: z.boolean(),
  balance: z.string(),
  rawBalance: z.string(),
  importance: z.string(),
  importanceNonZero: z.boolean(),
  balanceWithinLimits: z
    .boolean()
    .describe(
      'True when minHarvesterBalance <= balance <= maxHarvesterBalance (harvesting mosaic); outside that range the account cannot harvest.',
    ),
  canHarvestHere: z.boolean(),
  warnings: z.array(z.string()),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  accountResolution: AccountResolutionSchema,
  node: z.object({
    host: z.string(),
    unlockedCount: z.number(),
    unlockedPublicKeys: z.array(z.string()),
  }),
  limits: z.object({
    minHarvesterBalance: z.string(),
    rawMinHarvesterBalance: z.string(),
    maxHarvesterBalance: z.string(),
    rawMaxHarvesterBalance: z.string(),
    harvestBeneficiaryPercentage: z.number(),
    harvestingMosaic: z.object({
      id: z.string(),
      alias: nullable(z.string(), 'Alias of the harvesting mosaic; null when none.'),
      divisibility: z.number(),
    }),
  }),
  account: nullable(AccountReportSchema, 'Per-account report; null when no account was given.'),
});

const ZERO_KEY = '0'.repeat(64);

const BALANCE_STATE_TEXT: Record<HarvesterBalance, string> = {
  below: 'below the minimum',
  within: 'within the limits',
  above: 'above the maximum',
};

export const harvestingStatusTool = defineTool({
  name: 'symbol_harvesting_status',
  title: 'Symbol harvesting status',
  description:
    "List the delegated harvester keys unlocked on the configured node right now (/node/unlockedaccount) and the network's harvesting limits; with an account, also tell whether its linked key is among them. For whether an account's delegated harvesting works and where it stops, use symbol_delegation_diagnose; for how the unlocked list changed since the last check, symbol_harvester_watch; for harvesting rewards, symbol_harvesting_income. The limits are minHarvesterBalance, maxHarvesterBalance and harvestBeneficiaryPercentage. With an account, the tool also checks that the balance is within minHarvesterBalance and maxHarvesterBalance (both inclusive; an account outside that range cannot harvest) and the importance above zero, and lists warnings.",
  inputSchema,
  outputSchema,
  untrustedText: true,
  run: async (ctx, { account }, text) => {
    const [unlocked, { properties, currency }] = await Promise.all([
      ctx.rest.get('/node/unlockedaccount', UnlockedAccountSchema),
      ctx.getNetworkData(),
    ]);
    const unlockedKeys = unlocked.unlockedAccount.map((k) => k.toUpperCase());

    let harvestingMosaic: { id: string; alias: string | null; divisibility: number };
    if (properties.harvestingMosaicId === currency.mosaicId) {
      harvestingMosaic = {
        id: properties.harvestingMosaicId,
        alias: text.useOrNull(currency.alias),
        divisibility: currency.divisibility,
      };
    } else {
      const [info, aliases] = await Promise.all([
        ctx.rest.get(`/mosaics/${properties.harvestingMosaicId}`, MosaicInfoSchema),
        ctx.resolveMosaicAliases([properties.harvestingMosaicId]),
      ]);
      harvestingMosaic = {
        id: properties.harvestingMosaicId,
        alias: text.useOrNull(aliases.get(properties.harvestingMosaicId)),
        divisibility: info.mosaic.divisibility,
      };
    }
    const div = harvestingMosaic.divisibility;
    const label = harvestingMosaic.alias ?? harvestingMosaic.id;
    const limits = {
      minHarvesterBalance: formatAmount(properties.minHarvesterBalance, div),
      rawMinHarvesterBalance: properties.minHarvesterBalance.toString(),
      maxHarvesterBalance: formatAmount(properties.maxHarvesterBalance, div),
      rawMaxHarvesterBalance: properties.maxHarvesterBalance.toString(),
      harvestBeneficiaryPercentage: properties.harvestBeneficiaryPercentage,
      harvestingMosaic,
    };

    const lines: string[] = [
      `${ctx.rest.host} (${ctx.network.name}) has ${unlockedKeys.length} delegated harvester${unlockedKeys.length === 1 ? '' : 's'} unlocked. Harvesting requires a balance from ${limits.minHarvesterBalance} to ${limits.maxHarvesterBalance} ${label} (both inclusive) and non-zero importance; the node keeps ${properties.harvestBeneficiaryPercentage}% of block rewards.`,
    ];

    let report: z.output<typeof AccountReportSchema> | null = null;
    let resolution: AccountResolution | null = null;
    if (account !== undefined && account.trim() !== '') {
      const fetched = await fetchAccount(ctx, account);
      const info = fetched.info;
      resolution = fetched.resolution;
      const acct = info.account;
      const address = hexAddressToBase32(acct.address);
      const linked = acct.supplementalPublicKeys.linked?.publicKey.toUpperCase() ?? null;
      const vrf = acct.supplementalPublicKeys.vrf?.publicKey.toUpperCase() ?? null;
      const nodeKey = acct.supplementalPublicKeys.node?.publicKey.toUpperCase() ?? null;
      const rawBalance = BigInt(
        acct.mosaics.find((m) => m.id.toUpperCase() === harvestingMosaic.id)?.amount ?? '0',
      );
      const delegatedConfigured = linked !== null && vrf !== null;
      const unlockedHere = linked !== null && unlockedKeys.includes(linked);
      const importanceNonZero = BigInt(acct.importance) > 0n;
      // Both bounds, inclusive, as in catapult's ImportanceView::canHarvest: a block harvested by an
      // account outside them is rejected (EligibleHarvesterValidator), and the harvesting extension
      // drops such delegated harvesters from the node's unlocked list (UnlockedAccountsUpdater).
      const balanceState = classifyHarvesterBalance(
        rawBalance,
        properties.minHarvesterBalance,
        properties.maxHarvesterBalance,
      );
      const balanceWithinLimits = balanceState === 'within';
      const canHarvestHere =
        delegatedConfigured && unlockedHere && balanceWithinLimits && importanceNonZero;

      const warnings: string[] = [];
      if (!linked)
        warnings.push('No linked (remote) key: register an AccountKeyLink transaction first.');
      if (!vrf) warnings.push('No VRF key: register a VrfKeyLink transaction first.');
      if (!nodeKey)
        warnings.push('No node key link: the account has not delegated to a node (NodeKeyLink).');
      if (linked && !unlockedHere) {
        warnings.push(
          `The linked key ${linked.slice(0, 8)}… is not unlocked on ${ctx.rest.host}; the account may be delegated to a different node, or the node has not activated the delegation yet.`,
        );
      }
      if (balanceState === 'below') {
        warnings.push(
          `Balance ${formatAmount(rawBalance, div)} ${label} is below minHarvesterBalance ${limits.minHarvesterBalance}.`,
        );
      }
      if (balanceState === 'above') {
        warnings.push(
          `Balance ${formatAmount(rawBalance, div)} ${label} exceeds maxHarvesterBalance ${limits.maxHarvesterBalance}: an account above it cannot harvest, and nodes drop it from their unlocked list. Move the excess to another account.`,
        );
      }
      if (!importanceNonZero)
        warnings.push(
          'Importance is zero; the account cannot harvest until importance is recalculated with a qualifying balance.',
        );

      report = {
        address,
        publicKey: acct.publicKey.toUpperCase() === ZERO_KEY ? null : acct.publicKey.toUpperCase(),
        linkedPublicKey: linked,
        vrfPublicKey: vrf,
        nodePublicKey: nodeKey,
        delegatedHarvestingConfigured: delegatedConfigured,
        unlockedOnThisNode: unlockedHere,
        balance: formatAmount(rawBalance, div),
        rawBalance: rawBalance.toString(),
        importance: acct.importance,
        importanceNonZero,
        balanceWithinLimits,
        canHarvestHere,
        warnings,
      };
      lines.push(
        `${address}: delegated harvesting ${delegatedConfigured ? 'configured' : 'NOT configured'}; linked key ${linked ? `${linked.slice(0, 8)}… is ${unlockedHere ? '' : 'NOT '}unlocked on this node` : 'absent'}; balance ${report.balance} ${label} (${BALANCE_STATE_TEXT[balanceState]}); importance ${formatInteger(acct.importance)}. ${canHarvestHere ? 'This account can harvest on this node.' : 'This account cannot currently harvest on this node.'}`,
      );
      if (warnings.length > 0) lines.push(`Warnings: ${warnings.join(' ')}`);
    }

    return {
      summary: withResolutionPrefix(lines.join('\n'), resolution),
      network: ctx.network.name,
      accountResolution: resolution,
      node: {
        host: ctx.rest.host,
        unlockedCount: unlockedKeys.length,
        unlockedPublicKeys: unlockedKeys,
      },
      limits,
      account: report,
    };
  },
});
