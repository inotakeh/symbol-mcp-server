import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { type PromptDefinition, registerPrompts } from './prompts/_shared.js';
import { monthlyHealthCheckPrompt } from './prompts/monthly_health_check.js';
import { votingKeyRenewalChecklistPrompt } from './prompts/voting_key_renewal_checklist.js';
import { type AnyToolDefinition, registerTools } from './tools/_shared.js';
import { accountGetTool } from './tools/symbol_account_get.js';
import { accountRankTool } from './tools/symbol_account_rank.js';
import { addressParseTool } from './tools/symbol_address_parse.js';
import { delegationDiagnoseTool } from './tools/symbol_delegation_diagnose.js';
import { feeEstimateTool } from './tools/symbol_fee_estimate.js';
import { finalityParticipationTool } from './tools/symbol_finality_participation.js';
import { harvesterWatchTool } from './tools/symbol_harvester_watch.js';
import { harvestingIncomeTool } from './tools/symbol_harvesting_income.js';
import { harvestingStatusTool } from './tools/symbol_harvesting_status.js';
import { holdingsValueTool } from './tools/symbol_holdings_value.js';
import { mosaicGetTool } from './tools/symbol_mosaic_get.js';
import { namespaceGetTool } from './tools/symbol_namespace_get.js';
import { networkCompareTool } from './tools/symbol_network_compare.js';
import { networkInfoTool } from './tools/symbol_network_info.js';
import { nodeHealthTool } from './tools/symbol_node_health.js';
import { nodeStatusTool } from './tools/symbol_node_status.js';
import { timeConvertTool } from './tools/symbol_time_convert.js';
import { transactionGetTool } from './tools/symbol_transaction_get.js';
import { transactionSearchTool } from './tools/symbol_transaction_search.js';
import { transactionStatusTool } from './tools/symbol_transaction_status.js';
import { versionDriftTool } from './tools/symbol_version_drift.js';
import { votingKeyStatusTool } from './tools/symbol_voting_key_status.js';

export const SERVER_NAME = 'symbol-mcp-server';

type McpServerOptions = NonNullable<ConstructorParameters<typeof McpServer>[1]>;

/**
 * Cache hints for the 2026-07-28 revision (SEP-2549). The tool and prompt lists are static for
 * the life of the process and do not depend on who asks, so shared caches may keep them for a
 * day (the SDK client's own ceiling). Nothing else declares a hint: tool results and prompt
 * bodies keep the SDK default (ttlMs 0, cacheScope private). 2025-era responses never carry
 * these fields.
 */
export const LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const LIST_CACHE_HINTS: NonNullable<McpServerOptions['cacheHints']> = {
  'tools/list': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'public' },
  'prompts/list': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'public' },
};

/**
 * Registration order is fixed so `tools/list` is deterministic (2026-07-28 spec SHOULD).
 * Append new tools at the end; never reorder.
 */
export const TOOLS: readonly AnyToolDefinition[] = [
  networkInfoTool,
  nodeStatusTool,
  accountGetTool,
  votingKeyStatusTool,
  // Phase 2
  transactionGetTool,
  transactionSearchTool,
  mosaicGetTool,
  namespaceGetTool,
  feeEstimateTool,
  addressParseTool,
  timeConvertTool,
  harvestingStatusTool,
  networkCompareTool,
  // 0.2.0 (version comments name the CHANGELOG release that first shipped the tool)
  harvestingIncomeTool,
  transactionStatusTool,
  finalityParticipationTool,
  delegationDiagnoseTool,
  // 0.3.0
  nodeHealthTool,
  versionDriftTool,
  harvesterWatchTool,
  // 0.6.0
  accountRankTool,
  // 0.7.0
  holdingsValueTool,
];

/** Same rule as TOOLS: append only, never reorder, so `prompts/list` is deterministic. */
export const PROMPTS: readonly PromptDefinition[] = [
  votingKeyRenewalChecklistPrompt,
  monthlyHealthCheckPrompt,
];

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: ctx.serverVersion },
    { instructions: SERVER_INSTRUCTIONS, cacheHints: LIST_CACHE_HINTS },
  );
  registerTools(server, ctx, TOOLS);
  registerPrompts(server, PROMPTS);
  return server;
}
