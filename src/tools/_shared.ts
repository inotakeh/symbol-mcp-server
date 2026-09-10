/**
 * Shared plumbing for tool definitions: annotations, result shaping and error translation.
 *
 * Every tool returns BOTH `structuredContent` and a text block containing the same JSON
 * (spec backwards-compatibility requirement), with `summary` as the first field. Failures are
 * `{ isError: true }` results whose text says what went wrong and how to fix it. Stack traces
 * and raw HTTP bodies never reach the model.
 */
import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { RestError } from '../client/rest.js';
import type { AppContext } from '../context.js';
import { PropertyParseError } from '../domain/properties.js';

export const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * A field that is `null` when absent (never omitted), serialised portably.
 *
 * zod's JSON Schema generator folds `anyOf: [{type:'string'}, {type:'null'}]` into
 * `type: ['string','null']` whenever every branch is a bare type. Some MCP clients reject a
 * `type` array, so we keep a description on the value branch, which stops the folding and yields
 * `{"anyOf":[{"type":"string","description":"..."},{"type":"null"}]}`. The description is required
 * for that reason (and because it is the only documentation the model sees).
 * `test/tools/schema_portability.test.ts` guards this for every registered tool.
 */
export function nullable<T extends z.ZodType>(inner: T, description: string) {
  return z.union([inner.describe(description), z.null()]);
}

/** Thrown by tools for bad input or "not found" conditions; the message is shown to the model. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface ToolDefinition<I extends z.ZodObject | undefined, O extends z.ZodObject> {
  readonly name: `symbol_${string}`;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly run: (
    ctx: AppContext,
    input: I extends z.ZodObject ? z.output<I> : Record<string, never>,
  ) => Promise<z.output<O>>;
}

export function defineTool<I extends z.ZodObject | undefined, O extends z.ZodObject>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool list
export type AnyToolDefinition = ToolDefinition<any, any>;

export function okResult(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Shortens a long identifier for error messages (keeps 8 leading characters). */
export function maskIdentifier(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…` : value;
}

export function describeError(err: unknown, ctx: AppContext): string {
  if (err instanceof ToolInputError) return err.message;
  if (err instanceof RestError) {
    const host = ctx.rest.host;
    switch (err.kind) {
      case 'timeout':
        return `Node ${host} did not answer ${err.path} within ${ctx.config.requestTimeoutMs} ms. Check that the node is up, or raise SYMBOL_REQUEST_TIMEOUT_MS.`;
      case 'unreachable':
        return `Could not connect to node ${host}. Verify SYMBOL_NODE_URL (scheme, host, and port: 3000 for http, 3001 for https) and that the node is reachable from this machine.`;
      case 'not_found':
        return `${err.path} was not found on ${host} (${ctx.network.name}). The resource may not exist on this network; check the identifier and whether you meant mainnet or testnet.`;
      case 'http':
        return `Node ${host} answered HTTP ${err.status ?? 'error'} for ${err.path}. The node may be overloaded or misconfigured; retry later or point SYMBOL_NODE_URL at another node (see https://nodewatch.symbol.tools/).`;
      case 'invalid_response':
        return `Node ${host} returned an unexpected response shape for ${err.path}. It may run an incompatible catapult-rest version; try another node.`;
      case 'too_large':
        return `The response from ${host} for ${err.path} exceeded the size limit and was discarded.`;
      default:
        return `Request to ${host} failed.`;
    }
  }
  if (err instanceof PropertyParseError) {
    return `The node's /network/properties could not be parsed (${err.message}). The node may run an incompatible catapult-rest version.`;
  }
  // Internal failures: details go to stderr (never to the model), the reply stays generic.
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  console.error(`symbol-mcp-server: unexpected internal error: ${name}: ${message}`);
  return 'Unexpected internal error while running the tool. Retry; if it persists, report it with the tool name and arguments (details were written to the server log).';
}

async function execute(
  tool: AnyToolDefinition,
  ctx: AppContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const output = (await tool.run(ctx, args)) as Record<string, unknown>;
    return okResult(output);
  } catch (err) {
    return errorResult(describeError(err, ctx));
  }
}

/** Registers tools in the given (fixed) order so `tools/list` is deterministic. */
export function registerTools(
  server: McpServer,
  ctx: AppContext,
  tools: readonly AnyToolDefinition[],
): void {
  for (const tool of tools) {
    const base = {
      title: tool.title,
      description: tool.description,
      outputSchema: tool.outputSchema as z.ZodObject,
      annotations: TOOL_ANNOTATIONS,
    };
    if (tool.inputSchema) {
      server.registerTool(
        tool.name,
        { ...base, inputSchema: tool.inputSchema as z.ZodObject },
        async (args) => execute(tool, ctx, args as Record<string, unknown>),
      );
    } else {
      server.registerTool(tool.name, base, async () => execute(tool, ctx, {}));
    }
  }
}

export function formatInteger(n: number | bigint | string): string {
  return BigInt(n).toLocaleString('en-US');
}
