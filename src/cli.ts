/**
 * Command-line flag handling for the `symbol-mcp-server` binary.
 *
 * MCP hosts start the server with no arguments, so any argument comes from a human at a
 * terminal. Everything printed here goes to stderr: stdout is reserved for JSON-RPC and must
 * stay silent even when the process exits immediately.
 */
import { DEFAULT_REQUEST_TIMEOUT_MS } from './config.js';

export type CliCommand =
  | { readonly mode: 'serve' }
  | { readonly mode: 'help' }
  | { readonly mode: 'version' }
  | { readonly mode: 'unknown'; readonly arg: string };

const HELP_FLAGS = new Set(['--help', '-h', 'help']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version']);

/** Interprets `process.argv.slice(2)`. The first recognised flag wins; anything else is unknown. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const first = argv[0];
  if (first === undefined) return { mode: 'serve' };
  if (HELP_FLAGS.has(first)) return { mode: 'help' };
  if (VERSION_FLAGS.has(first)) return { mode: 'version' };
  return { mode: 'unknown', arg: first };
}

export interface EnvVarDoc {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

/** Mirrors `loadConfig` in config.ts. Keep the two in sync when adding a variable. */
export const ENV_VARS: readonly EnvVarDoc[] = [
  {
    name: 'SYMBOL_NODE_URL',
    required: true,
    description:
      'REST URL of the Symbol node to query, e.g. https://<node-host>:3001. https:// is required (http:// only for localhost / 127.0.0.1). The port is used exactly as given.',
  },
  {
    name: 'SYMBOL_NETWORK',
    required: false,
    description:
      '"mainnet" or "testnet". When set, start-up fails if the node reports a different network.',
  },
  {
    name: 'SYMBOL_TIMEZONE',
    required: false,
    description:
      'IANA time zone such as Asia/Tokyo. Adds a local time next to every UTC timestamp in tool output.',
  },
  {
    name: 'SYMBOL_REFERENCE_NODES',
    required: false,
    description:
      'Comma-separated https:// node URLs compared by symbol_network_compare. No other host is ever contacted.',
  },
  {
    name: 'SYMBOL_REQUEST_TIMEOUT_MS',
    required: false,
    description: `Per-request timeout in milliseconds, 100 to 600000. Default ${DEFAULT_REQUEST_TIMEOUT_MS}.`,
  },
];

const PUBLIC_NODES = [
  ['mainnet', 'https://sym-main-01.opening-line.jp:3001'],
  ['testnet', 'https://sym-test-01.opening-line.jp:3001'],
] as const;

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((l) => `${indent}${l}`).join('\n');
}

export function helpText(serverName: string, version: string): string {
  const out: string[] = [];
  out.push(`${serverName} ${version}`);
  out.push('Read-only MCP server for the Symbol blockchain (stdio transport).');
  out.push('');
  out.push('Usage:');
  out.push(`  SYMBOL_NODE_URL=https://<node>:3001 ${serverName}`);
  out.push(`  ${serverName} --help       Show this message and exit`);
  out.push(`  ${serverName} --version    Print the version and exit`);
  out.push('');
  out.push('The server is normally started by an MCP host (Claude Desktop, Claude Code, ...),');
  out.push('which passes the environment variables below. stdout carries JSON-RPC; all logs and');
  out.push('this help text go to stderr.');
  out.push('');
  out.push('Environment variables:');
  for (const v of ENV_VARS) {
    out.push(`  ${v.name}${v.required ? '  (required)' : ''}`);
    out.push(wrap(v.description, 72, '      '));
  }
  out.push('');
  out.push('Public nodes (availability may change; see https://nodewatch.symbol.tools/):');
  for (const [network, url] of PUBLIC_NODES) {
    out.push(`  ${network.padEnd(8)} ${url}`);
  }
  out.push('');
  out.push('On start-up the server fetches /node/info, detects mainnet or testnet from the');
  out.push(`generation hash seed and logs "${serverName} <version>: <network> via <host>".`);
  return out.join('\n');
}
