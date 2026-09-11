import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import { type AnyToolDefinition, registerTools } from './tools/_shared.js';
import { accountGetTool } from './tools/symbol_account_get.js';
import { addressParseTool } from './tools/symbol_address_parse.js';
import { feeEstimateTool } from './tools/symbol_fee_estimate.js';
import { harvestingIncomeTool } from './tools/symbol_harvesting_income.js';
import { harvestingStatusTool } from './tools/symbol_harvesting_status.js';
import { mosaicGetTool } from './tools/symbol_mosaic_get.js';
import { namespaceGetTool } from './tools/symbol_namespace_get.js';
import { networkCompareTool } from './tools/symbol_network_compare.js';
import { networkInfoTool } from './tools/symbol_network_info.js';
import { nodeStatusTool } from './tools/symbol_node_status.js';
import { timeConvertTool } from './tools/symbol_time_convert.js';
import { transactionGetTool } from './tools/symbol_transaction_get.js';
import { transactionSearchTool } from './tools/symbol_transaction_search.js';
import { votingKeyStatusTool } from './tools/symbol_voting_key_status.js';

export const SERVER_NAME = 'symbol-mcp-server';

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
  // 0.2.0
  harvestingIncomeTool,
];

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: ctx.serverVersion });
  registerTools(server, ctx, TOOLS);
  return server;
}
