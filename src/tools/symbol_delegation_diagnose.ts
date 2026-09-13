import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import {
  AccountInfoSchema,
  ChainInfoSchema,
  MosaicInfoSchema,
  NodeInfoSchema,
  TransactionPageSchema,
  TransactionStatementPageSchema,
  UnlockedAccountSchema,
} from '../client/schemas.js';
import type { AppContext } from '../context.js';
import { hexAddressToBase32, publicKeyToAddress } from '../domain/address.js';
import { formatAmount } from '../domain/amount.js';
import {
  blocksUntilImportanceRecalculation,
  type CheckStatus,
  type DiagnoseCheck,
  deriveVerdict,
  hasKey,
  nextImportanceRecalculationHeight,
  sameKey,
} from '../domain/delegation.js';
import { parseHeight } from '../domain/epoch.js';
import { classifyHarvestReceipts } from '../domain/harvesting.js';
import { isPersistentDelegationMessage } from '../domain/message.js';
import { receiptTypeCode } from '../domain/receipttype.js';
import { formatInstantText, type Instant, networkTimestampToDate } from '../domain/time.js';
import { parseTransactionType } from '../domain/txtype.js';
import { AccountResolutionSchema, resolveAccountInput, withResolutionPrefix } from './_accounts.js';
import { defineTool, formatInteger, maskIdentifier, nullable } from './_shared.js';
import { InstantSchema } from './_transactions.js';
import { ACCOUNT_TYPES } from './symbol_account_get.js';

export const MIN_RECENT_DAYS = 1;
export const MAX_RECENT_DAYS = 30;
export const DEFAULT_RECENT_DAYS = 7;
/** Receipt pages read for the recent-harvest check (100 rows each, newest first). */
export const MAX_RECENT_HARVEST_PAGES = 20;
const STATEMENT_PAGE_SIZE = 100;
/** Transfers inspected for the delegation request (one page, newest first). */
const DELEGATION_REQUEST_PAGE_SIZE = 100;
const ZERO_KEY = '0'.repeat(64);
const MS_PER_DAY = 86_400_000;

/** AccountTypeEnum value 1: balance-holding account linked to a remote harvester (symbol-openapi). */
const ACCOUNT_TYPE_MAIN = 1;

const inputSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe(
      'Account whose delegated harvesting to diagnose: base32 address (39 chars), hex public key (64 chars), or a namespace name with an address alias (e.g. alice, alice.pay; resolved through the node). Hex addresses (48 chars) are also accepted. Pass the main (balance-holding) account, not the remote key.',
    ),
  recentDays: z
    .number()
    .int()
    .min(MIN_RECENT_DAYS)
    .max(MAX_RECENT_DAYS)
    .default(DEFAULT_RECENT_DAYS)
    .describe(
      `How many recent days to search for harvested blocks as evidence that delegation works, ${MIN_RECENT_DAYS} to ${MAX_RECENT_DAYS} (default ${DEFAULT_RECENT_DAYS}).`,
    ),
  format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      'concise (default): hints only on checks that are not ok. detailed: a hint on every check, including what was compared for the ok ones.',
    ),
});

const CheckSchema = z.object({
  id: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'unknown']),
  detail: z.string(),
  hint: nullable(z.string(), 'What to do about this check; null when nothing is needed.'),
});

const outputSchema = z.object({
  summary: z.string(),
  network: z.string(),
  accountResolution: AccountResolutionSchema,
  address: z.string(),
  verdict: z.enum(['active', 'not_active', 'cannot_verify']),
  checks: z.array(CheckSchema),
  account: z.object({
    balanceXym: z.string(),
    rawBalance: z.string(),
    importance: z.string(),
    importanceHeight: z.number(),
    accountType: z.object({ code: z.number(), name: z.string() }),
    keys: z.object({
      linked: nullable(z.string(), 'Linked (remote) public key; null when not registered.'),
      vrf: nullable(z.string(), 'VRF public key; null when not registered.'),
      node: nullable(z.string(), 'Node public key the account delegated to; null when not set.'),
    }),
  }),
  node: z.object({
    configuredNodePublicKey: nullable(
      z.string(),
      'nodePublicKey reported by the configured node; null when the node does not report one.',
    ),
    unlockedCount: nullable(
      z.number(),
      'Delegated harvesters unlocked on the configured node; null when /node/unlockedaccount failed.',
    ),
  }),
  recentHarvest: nullable(
    z.object({
      days: z.number(),
      receipts: z.number(),
      lastHeight: nullable(z.number(), 'Height of the newest harvested block; null when none.'),
      lastTime: nullable(InstantSchema, 'Time of the newest harvested block; null when none.'),
    }),
    'Harvested blocks in the recent window; null when the account does not exist.',
  ),
  notes: z.array(z.string()),
});

type Output = z.output<typeof outputSchema>;

interface CheckInput {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
}

function check(input: CheckInput): DiagnoseCheck {
  return { id: input.id, status: input.status, detail: input.detail, hint: input.hint ?? null };
}

/** Everything after a missing account is unknown: there is nothing to inspect. */
function unknownChecks(ids: readonly string[], detail: string): DiagnoseCheck[] {
  return ids.map((id) => check({ id, status: 'unknown', detail }));
}

const CHECK_IDS = [
  'account_exists',
  'balance_in_range',
  'importance_positive',
  'linked_key',
  'vrf_key',
  'node_key',
  'node_key_matches_configured_node',
  'unlocked_on_node',
  'account_type',
  'recent_harvest',
  'delegation_request_found',
] as const;

const VERDICT_TEXT: Record<Output['verdict'], string> = {
  active: 'active',
  not_active: 'not active',
  cannot_verify: 'cannot verify',
};

const NOTES = [
  'The unlocked-harvester list (/node/unlockedaccount) is reported by the node itself and is not backed by chain data.',
  'Only delegation to the configured node (SYMBOL_NODE_URL) can be checked on the node side; delegation to another node is not verified because no other host is contacted.',
  'Importance is recalculated every importanceGrouping blocks; a new or refilled account harvests only after the next recalculation.',
  'The recent-harvest window is converted to a height range with the measured average block time, so its start is approximate.',
];

function buildSummary(
  address: string,
  verdict: Output['verdict'],
  checks: readonly DiagnoseCheck[],
  recent: {
    days: number;
    receipts: number;
    lastHeight: number | null;
    lastTime: Instant | null;
  } | null,
): string {
  const lines = [`delegated harvesting: ${VERDICT_TEXT[verdict]} (${address}).`];
  for (const c of checks) {
    if (c.status === 'fail' || c.status === 'warn')
      lines.push(`- ${c.id} ${c.status}: ${c.detail}`);
  }
  if (verdict === 'cannot_verify') {
    const unknown = checks.filter((c) => c.status === 'unknown').map((c) => c.id);
    lines.push(`- could not verify: ${unknown.join(', ')}.`);
  }
  if (recent && recent.receipts > 0 && recent.lastTime) {
    lines.push(
      `- harvested ${formatInteger(recent.receipts)} block${recent.receipts === 1 ? '' : 's'} in the last ${recent.days} day${recent.days === 1 ? '' : 's'}; newest at height ${formatInteger(recent.lastHeight ?? 0)} (${formatInstantText(recent.lastTime)}).`,
    );
  }
  return lines.join('\n');
}

async function fetchUnlockedKeys(ctx: AppContext): Promise<string[] | null> {
  try {
    const unlocked = await ctx.rest.get('/node/unlockedaccount', UnlockedAccountSchema);
    return unlocked.unlockedAccount.map((k) => k.toUpperCase());
  } catch (err) {
    if (err instanceof RestError) return null;
    throw err;
  }
}

interface RecentHarvest {
  readonly receipts: number;
  readonly lastHeight: number | null;
  readonly lastTimestamp: number | null;
  readonly truncated: boolean;
}

/**
 * Counts HarvestFee receipts of the network currency addressed to the account whose share
 * pattern marks them as the harvester's (or could not be classified). Beneficiary receipts are
 * left out: they prove that someone else harvested with this account as beneficiary.
 */
async function countRecentHarvests(
  ctx: AppContext,
  base32: string,
  addressHex: string,
  fromHeight: number,
  toHeight: number,
  currencyMosaicId: string,
  shares: { beneficiaryPercentage: number; networkPercentage: number },
): Promise<RecentHarvest> {
  const harvestFeeType = receiptTypeCode('HarvestFee');
  let receipts = 0;
  let lastHeight: number | null = null;
  let lastTimestamp: number | null = null;
  let truncated = true;
  for (let pageNumber = 1; pageNumber <= MAX_RECENT_HARVEST_PAGES; pageNumber++) {
    const params = new URLSearchParams({
      receiptType: String(harvestFeeType),
      targetAddress: base32,
      fromHeight: String(fromHeight),
      toHeight: String(toHeight),
      pageSize: String(STATEMENT_PAGE_SIZE),
      order: 'desc',
      pageNumber: String(pageNumber),
    });
    const page = await ctx.rest.get(
      `/statements/transaction?${params.toString()}`,
      TransactionStatementPageSchema,
    );
    for (const row of page.data) {
      const harvestReceipts = row.statement.receipts.filter(
        (r) => r.type === harvestFeeType && (r.mosaicId?.toUpperCase() ?? '') === currencyMosaicId,
      );
      const mine = classifyHarvestReceipts(harvestReceipts, shares).filter(
        (r) =>
          (r.receipt.targetAddress?.toUpperCase() ?? '') === addressHex && r.kind !== 'beneficiary',
      );
      if (mine.length === 0) continue;
      receipts += mine.length;
      const height = parseHeight(row.statement.height);
      if (lastHeight === null || height > lastHeight) {
        lastHeight = height;
        lastTimestamp = Number(row.meta.timestamp);
      }
    }
    if (page.data.length < STATEMENT_PAGE_SIZE) {
      truncated = false;
      break;
    }
  }
  return { receipts, lastHeight, lastTimestamp, truncated };
}

interface DelegationRequest {
  readonly height: number | null;
  readonly timestamp: number | null;
  readonly inspected: number;
}

/**
 * Newest top-level transfer from the account to the configured node's transport-key address
 * whose message starts with the persistent delegation marker (see domain/message.ts for the
 * catapult rule this mirrors). Embedded transfers are not searched (`embedded` stays false).
 */
async function findDelegationRequest(
  ctx: AppContext,
  signerPublicKey: string,
  recipientAddress: string,
): Promise<DelegationRequest> {
  const transfer = parseTransactionType('Transfer');
  if (!transfer) throw new Error('Transfer type missing from the transaction type table');
  const params = new URLSearchParams({
    signerPublicKey,
    recipientAddress,
    type: String(transfer.code),
    pageSize: String(DELEGATION_REQUEST_PAGE_SIZE),
    order: 'desc',
    pageNumber: '1',
  });
  const page = await ctx.rest.get(
    `/transactions/confirmed?${params.toString()}`,
    TransactionPageSchema,
  );
  const found = page.data.find((info) => isPersistentDelegationMessage(info.transaction.message));
  return {
    height: found?.meta.height !== undefined ? parseHeight(found.meta.height) : null,
    timestamp: found?.meta.timestamp !== undefined ? Number(found.meta.timestamp) : null,
    inspected: page.data.length,
  };
}

export const delegationDiagnoseTool = defineTool({
  name: 'symbol_delegation_diagnose',
  title: 'Symbol delegated harvesting diagnosis',
  description:
    "Diagnose whether an account's delegated harvesting is active and, if not, where it stops: account exists, balance within minHarvesterBalance/maxHarvesterBalance, importance above zero (or blocks until the next recalculation), linked/VRF/node keys registered, node key equal to the configured node's nodePublicKey, remote key unlocked on the configured node, account type, harvested blocks in the last N days, and the persistent delegation request transfer to the node. Each check is ok/warn/fail/unknown with a hint; the verdict is active, not_active or cannot_verify. Node-side checks are possible only when the account delegates to the configured node; no other node is contacted. Read-only.",
  inputSchema,
  outputSchema,
  run: async (ctx, { account, recentDays, format }) => {
    const { classified, resolution } = await resolveAccountInput(ctx, account);

    const [accountInfo, { properties, currency }, chain, nodeInfo, unlockedKeys] =
      await Promise.all([
        ctx.rest.getOrNull(`/accounts/${classified.canonical}`, AccountInfoSchema),
        ctx.getNetworkData(),
        ctx.rest.get('/chain/info', ChainInfoSchema),
        ctx.rest.get('/node/info', NodeInfoSchema),
        fetchUnlockedKeys(ctx),
      ]);
    const currentHeight = parseHeight(chain.height);
    const configuredNodeKey = nodeInfo.nodePublicKey?.toUpperCase() ?? null;
    const nodeBlock = {
      configuredNodePublicKey: configuredNodeKey,
      unlockedCount: unlockedKeys === null ? null : unlockedKeys.length,
    };
    const notes = [...NOTES];

    // Harvesting eligibility is defined on chain.harvestingMosaicId (symbol-openapi
    // ChainPropertiesDTO: "Mosaic id used to provide harvesting ability"), not on
    // currencyMosaicId ("Mosaic id used as primary chain currency"). They are the same mosaic on
    // mainnet and testnet, but a network may separate them, and minHarvesterBalance /
    // maxHarvesterBalance are counted in the harvesting mosaic. The property parser treats
    // harvestingMosaicId as required (it is in the OpenAPI DTO), so the fallback below is only a
    // guard against an empty value.
    const harvestingMosaicId =
      properties.harvestingMosaicId !== '' ? properties.harvestingMosaicId : currency.mosaicId;
    let harvestingDivisibility = currency.divisibility;
    let harvestingLabel = currency.alias ?? currency.mosaicId;
    if (harvestingMosaicId !== currency.mosaicId) {
      const [info, aliases] = await Promise.all([
        ctx.rest.get(`/mosaics/${harvestingMosaicId}`, MosaicInfoSchema),
        ctx.resolveMosaicAliases([harvestingMosaicId]),
      ]);
      harvestingDivisibility = info.mosaic.divisibility;
      harvestingLabel = aliases.get(harvestingMosaicId) ?? harvestingMosaicId;
    }

    if (accountInfo === null) {
      const address =
        classified.kind === 'publicKey'
          ? publicKeyToAddress(classified.canonical, ctx.network.identifier)
          : classified.canonical;
      const checks: DiagnoseCheck[] = [
        check({
          id: 'account_exists',
          status: 'fail',
          detail: `No account ${address} exists on ${ctx.network.name} (node ${ctx.rest.host}).`,
          hint: 'Accounts appear on-chain only after their first transaction. Check the identifier and whether you meant mainnet or testnet.',
        }),
        ...unknownChecks(CHECK_IDS.slice(1), 'Not checked: the account does not exist.'),
      ];
      const verdict = deriveVerdict(checks);
      return {
        summary: withResolutionPrefix(buildSummary(address, verdict, checks, null), resolution),
        network: ctx.network.name,
        accountResolution: resolution,
        address,
        verdict,
        checks,
        account: {
          balanceXym: formatAmount(0n, harvestingDivisibility),
          rawBalance: '0',
          importance: '0',
          importanceHeight: 0,
          accountType: { code: 0, name: ACCOUNT_TYPES[0] ?? 'Unlinked' },
          keys: { linked: null, vrf: null, node: null },
        },
        node: nodeBlock,
        recentHarvest: null,
        notes,
      };
    }

    const acct = accountInfo.account;
    const addressHex = acct.address.toUpperCase();
    const address = hexAddressToBase32(addressHex);
    const publicKey =
      acct.publicKey.toUpperCase() === ZERO_KEY ? null : acct.publicKey.toUpperCase();
    const linked = acct.supplementalPublicKeys.linked?.publicKey.toUpperCase() ?? null;
    const vrf = acct.supplementalPublicKeys.vrf?.publicKey.toUpperCase() ?? null;
    const nodeKey = acct.supplementalPublicKeys.node?.publicKey.toUpperCase() ?? null;
    const rawBalance = BigInt(
      acct.mosaics.find((m) => m.id.toUpperCase() === harvestingMosaicId)?.amount ?? '0',
    );
    const balanceText = `${formatAmount(rawBalance, harvestingDivisibility)} ${harvestingLabel}`;
    const minText = `${formatAmount(properties.minHarvesterBalance, harvestingDivisibility)} ${harvestingLabel}`;
    const maxText = `${formatAmount(properties.maxHarvesterBalance, harvestingDivisibility)} ${harvestingLabel}`;
    const importance = BigInt(acct.importance);
    const importanceHeight = parseHeight(acct.importanceHeight);
    const checks: DiagnoseCheck[] = [];

    checks.push(
      check({
        id: 'account_exists',
        status: 'ok',
        detail: `Account ${address} exists on ${ctx.network.name}.`,
        hint: 'Read from /accounts/{id} on the configured node.',
      }),
    );

    // 2. balance_in_range
    const balanceOk =
      rawBalance >= properties.minHarvesterBalance && rawBalance <= properties.maxHarvesterBalance;
    if (rawBalance < properties.minHarvesterBalance) {
      checks.push(
        check({
          id: 'balance_in_range',
          status: 'fail',
          detail: `Balance ${balanceText} is below minHarvesterBalance ${minText}.`,
          hint: `Hold at least ${minText} on the main account; importance is only assigned above that threshold.`,
        }),
      );
    } else if (rawBalance > properties.maxHarvesterBalance) {
      checks.push(
        check({
          id: 'balance_in_range',
          status: 'fail',
          detail: `Balance ${balanceText} exceeds maxHarvesterBalance ${maxText}.`,
          hint: `Accounts above maxHarvesterBalance cannot harvest; move the excess to another account so the balance stays at or below ${maxText}.`,
        }),
      );
    } else {
      checks.push(
        check({
          id: 'balance_in_range',
          status: 'ok',
          detail: `Balance ${balanceText} is within ${minText} to ${maxText}.`,
          hint: `Compared the ${harvestingLabel} balance with chain.minHarvesterBalance and chain.maxHarvesterBalance.`,
        }),
      );
    }

    // 3. importance_positive
    if (importance > 0n) {
      checks.push(
        check({
          id: 'importance_positive',
          status: 'ok',
          detail: `Importance ${formatInteger(importance)} (calculated at height ${formatInteger(importanceHeight)}).`,
          hint: 'Importance above zero means the account is eligible to be selected as a harvester.',
        }),
      );
    } else {
      const remaining = blocksUntilImportanceRecalculation(
        currentHeight,
        properties.importanceGrouping,
      );
      const nextHeight = nextImportanceRecalculationHeight(
        currentHeight,
        properties.importanceGrouping,
      );
      checks.push(
        check({
          id: 'importance_positive',
          status: balanceOk ? 'warn' : 'fail',
          detail: `Importance is zero (importanceHeight ${formatInteger(importanceHeight)}, current height ${formatInteger(currentHeight)}).`,
          hint: balanceOk
            ? `Wait for the next importance recalculation at height ${formatInteger(nextHeight)}, about ${formatInteger(remaining)} blocks away (importanceGrouping ${formatInteger(properties.importanceGrouping)}), then check again.`
            : 'Importance stays zero while the balance is outside the harvesting limits; fix the balance first.',
        }),
      );
    }

    // 4-6. keys
    const keyCheck = (
      id: string,
      key: string | null,
      label: string,
      txName: string,
    ): DiagnoseCheck =>
      hasKey(key)
        ? check({
            id,
            status: 'ok',
            detail: `${label} key ${maskIdentifier(key)} is registered.`,
            hint: `Registered through a ${txName} transaction.`,
          })
        : check({
            id,
            status: 'fail',
            detail: `No ${label} key is registered.`,
            hint: `Register the ${label} key with a ${txName} transaction (wallets do this as part of "activate delegated harvesting").`,
          });
    checks.push(keyCheck('linked_key', linked, 'linked (remote)', 'AccountKeyLink'));
    checks.push(keyCheck('vrf_key', vrf, 'VRF', 'VrfKeyLink'));
    checks.push(keyCheck('node_key', nodeKey, 'node', 'NodeKeyLink'));

    // 7. node_key_matches_configured_node
    let nodeMatch: CheckStatus;
    if (!hasKey(nodeKey)) {
      nodeMatch = 'unknown';
      checks.push(
        check({
          id: 'node_key_matches_configured_node',
          status: 'unknown',
          detail: 'The account has no node key, so the delegation target is unknown.',
          hint: 'Register the node key of the node you delegate to (NodeKeyLink) and re-run.',
        }),
      );
    } else if (configuredNodeKey === null) {
      nodeMatch = 'unknown';
      checks.push(
        check({
          id: 'node_key_matches_configured_node',
          status: 'unknown',
          detail: `${ctx.rest.host} does not report a nodePublicKey in /node/info, so the account's node key cannot be compared.`,
          hint: 'Ask the operator of the configured node; the REST gateway needs the node public key configured to report it.',
        }),
      );
    } else if (sameKey(nodeKey, configuredNodeKey)) {
      nodeMatch = 'ok';
      checks.push(
        check({
          id: 'node_key_matches_configured_node',
          status: 'ok',
          detail: `The account's node key matches the nodePublicKey of ${ctx.rest.host}.`,
          hint: 'The account delegates to the configured node, so node-side checks apply.',
        }),
      );
    } else {
      nodeMatch = 'warn';
      checks.push(
        check({
          id: 'node_key_matches_configured_node',
          status: 'warn',
          detail: `The account's node key ${maskIdentifier(nodeKey)} differs from the nodePublicKey ${maskIdentifier(configuredNodeKey)} of ${ctx.rest.host}: the account delegates to a different node.`,
          hint: 'Node-side checks (unlocked harvester, delegation request) cannot be verified from this server. Point SYMBOL_NODE_URL at the node the account delegates to, or ask that node operator.',
        }),
      );
    }

    // 8. unlocked_on_node
    if (nodeMatch !== 'ok') {
      checks.push(
        check({
          id: 'unlocked_on_node',
          status: 'unknown',
          detail:
            nodeMatch === 'warn'
              ? 'Not checked: the account delegates to a different node than the configured one.'
              : 'Not checked: the delegation target could not be established.',
        }),
      );
    } else if (unlockedKeys === null) {
      checks.push(
        check({
          id: 'unlocked_on_node',
          status: 'unknown',
          detail: `${ctx.rest.host} did not answer /node/unlockedaccount.`,
          hint: 'Retry later or ask the node operator; the rest of the diagnosis does not depend on it.',
        }),
      );
    } else if (hasKey(linked) && unlockedKeys.includes(linked)) {
      checks.push(
        check({
          id: 'unlocked_on_node',
          status: 'ok',
          detail: `The linked key ${maskIdentifier(linked)} is among the ${formatInteger(unlockedKeys.length)} harvesters unlocked on ${ctx.rest.host}.`,
          hint: 'The node has accepted the delegation request and can harvest with this account.',
        }),
      );
    } else {
      checks.push(
        check({
          id: 'unlocked_on_node',
          status: 'fail',
          detail: hasKey(linked)
            ? `The linked key ${maskIdentifier(linked)} is not among the ${formatInteger(unlockedKeys.length)} harvesters unlocked on ${ctx.rest.host}.`
            : `No linked key to look for among the ${formatInteger(unlockedKeys.length)} harvesters unlocked on ${ctx.rest.host}.`,
          hint: 'The node has not activated the delegation: the request may not have been received yet, it must be re-sent after a node restart if the node does not persist delegations, or the node may have no free harvester slot. Ask the node operator.',
        }),
      );
    }

    // 9. account_type
    const accountTypeName = ACCOUNT_TYPES[acct.accountType] ?? 'Unknown';
    checks.push(
      acct.accountType === ACCOUNT_TYPE_MAIN
        ? check({
            id: 'account_type',
            status: 'ok',
            detail: `Account type ${accountTypeName} (${acct.accountType}): a balance-holding account linked to a remote harvester.`,
            hint: 'This is the expected type for a delegating main account.',
          })
        : check({
            id: 'account_type',
            status: 'warn',
            detail: `Account type ${accountTypeName} (${acct.accountType}) is not Main (1).`,
            hint:
              acct.accountType === 2 || acct.accountType === 3
                ? 'This looks like the remote (linked) account; diagnose the main account that holds the balance instead.'
                : 'The account is not linked to a remote harvester yet; the linked-key check explains what is missing.',
          }),
    );

    // 10. recent_harvest
    const blockTime = await ctx.getAverageBlockTime(currentHeight);
    const windowBlocks = Math.ceil((recentDays * MS_PER_DAY) / blockTime.averageBlockTimeMs);
    const fromHeight = Math.max(1, currentHeight - windowBlocks);
    const recent = await countRecentHarvests(
      ctx,
      address,
      addressHex,
      fromHeight,
      currentHeight,
      currency.mosaicId,
      {
        beneficiaryPercentage: properties.harvestBeneficiaryPercentage,
        networkPercentage: properties.harvestNetworkPercentage,
      },
    );
    const lastTime =
      recent.lastTimestamp === null
        ? null
        : ctx.instant(
            networkTimestampToDate(recent.lastTimestamp, properties.epochAdjustmentSeconds),
          );
    const recentHarvest = {
      days: recentDays,
      receipts: recent.receipts,
      lastHeight: recent.lastHeight,
      lastTime,
    };
    if (recent.truncated) {
      notes.push(
        `recentHarvest counts only the newest ${formatInteger(MAX_RECENT_HARVEST_PAGES * STATEMENT_PAGE_SIZE)} receipt rows of the window; the account harvested at least that many blocks.`,
      );
    }
    const failedSoFar = checks.some((c) => c.status === 'fail');
    const daysText = `${recentDays} day${recentDays === 1 ? '' : 's'}`;
    if (recent.receipts > 0 && recent.lastHeight !== null && lastTime !== null) {
      checks.push(
        check({
          id: 'recent_harvest',
          status: 'ok',
          detail: `Harvested ${formatInteger(recent.receipts)} block${recent.receipts === 1 ? '' : 's'} in the last ${daysText}; newest at height ${formatInteger(recent.lastHeight)} (${formatInstantText(lastTime)}).`,
          hint: 'Harvest fee receipts addressed to this account as harvester (beneficiary receipts are not counted).',
        }),
      );
    } else if (failedSoFar) {
      checks.push(
        check({
          id: 'recent_harvest',
          status: 'unknown',
          detail: `No harvested block in the last ${daysText} (heights ${formatInteger(fromHeight)} to ${formatInteger(currentHeight)}); expected while an earlier check fails.`,
        }),
      );
    } else {
      checks.push(
        check({
          id: 'recent_harvest',
          status: 'warn',
          detail: `No harvested block in the last ${daysText} (heights ${formatInteger(fromHeight)} to ${formatInteger(currentHeight)}).`,
          hint: 'Delegation looks active but the account has not been selected recently. Harvesting is probabilistic: a small importance can mean long gaps between blocks. Widen recentDays or compare with symbol_harvesting_income over a longer period.',
        }),
      );
    }

    // 11. delegation_request_found
    if (nodeMatch !== 'ok') {
      checks.push(
        check({
          id: 'delegation_request_found',
          status: 'unknown',
          detail:
            nodeMatch === 'warn'
              ? 'Not checked: only requests addressed to the configured node are searched.'
              : 'Not checked: the configured node key is unknown.',
        }),
      );
    } else if (publicKey === null || configuredNodeKey === null) {
      checks.push(
        check({
          id: 'delegation_request_found',
          status: 'unknown',
          detail: 'Not checked: the account has no public key on chain yet.',
        }),
      );
    } else {
      const nodeAddress = publicKeyToAddress(configuredNodeKey, ctx.network.identifier);
      const request = await findDelegationRequest(ctx, publicKey, nodeAddress);
      if (request.height !== null && request.timestamp !== null) {
        const when = ctx.instant(
          networkTimestampToDate(request.timestamp, properties.epochAdjustmentSeconds),
        );
        checks.push(
          check({
            id: 'delegation_request_found',
            status: 'ok',
            detail: `Newest persistent delegation request to ${ctx.rest.host} confirmed at height ${formatInteger(request.height)} (${formatInstantText(when)}).`,
            hint: `A transfer from the account to ${nodeAddress} (the address of the node's nodePublicKey) whose message starts with the delegation marker.`,
          }),
        );
      } else {
        checks.push(
          check({
            id: 'delegation_request_found',
            status: 'warn',
            detail: `No persistent delegation request to ${ctx.rest.host} among the newest ${formatInteger(request.inspected)} transfers from the account to ${nodeAddress}.`,
            hint: 'Only top-level transfers are searched (a request inside an aggregate is not seen). The request may also be older than the searched page, or it may have been sent to another node. If the node has the account unlocked, this is informational.',
          }),
        );
      }
    }

    const verdict = deriveVerdict(checks);
    const shownChecks =
      format === 'detailed'
        ? checks
        : checks.map((c) => (c.status === 'ok' ? { ...c, hint: null } : c));

    return {
      summary: withResolutionPrefix(
        buildSummary(address, verdict, checks, recentHarvest),
        resolution,
      ),
      network: ctx.network.name,
      accountResolution: resolution,
      address,
      verdict,
      checks: shownChecks,
      account: {
        balanceXym: formatAmount(rawBalance, harvestingDivisibility),
        rawBalance: rawBalance.toString(),
        importance: acct.importance,
        importanceHeight,
        accountType: { code: acct.accountType, name: accountTypeName },
        keys: { linked, vrf, node: nodeKey },
      },
      node: nodeBlock,
      recentHarvest,
      notes,
    };
  },
});
