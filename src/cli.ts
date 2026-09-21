/**
 * Command-line handling for the `symbol-mcp-server` binary.
 *
 * MCP hosts start the server with no arguments, so any argument comes from a human at a
 * terminal or from cron. In server mode stdout is reserved for JSON-RPC and must stay silent even
 * when the process exits immediately, so help, version and every error go to stderr. The only
 * thing ever written to stdout is the report of the `check` subcommand, which never serves MCP.
 */
import {
  type CheckReport,
  DEFAULT_WARN_DAYS,
  MAX_WARN_DAYS,
  MIN_WARN_DAYS,
  runCheck,
} from './cli/check.js';
import { formatCheckJson, formatCheckText } from './cli/format.js';
import { RestError } from './client/rest.js';
import { ConfigError, DEFAULT_REQUEST_TIMEOUT_MS, NetworkVerificationError } from './config.js';
import { createAppContext } from './context.js';
import { classifyAccountId } from './domain/address.js';
import { SERVER_NAME } from './server.js';
import { ACCOUNT_INPUT_HINT } from './tools/_accounts.js';
import { maskIdentifier } from './tools/_shared.js';

export interface CheckCliOptions {
  readonly account: string | null;
  readonly warnDays: number;
  readonly format: 'text' | 'json';
  readonly quiet: boolean;
}

export type CliCommand =
  | { readonly mode: 'serve' }
  | { readonly mode: 'help' }
  | { readonly mode: 'version' }
  | { readonly mode: 'check'; readonly options: CheckCliOptions }
  | { readonly mode: 'check_usage'; readonly message: string }
  | { readonly mode: 'unknown'; readonly arg: string };

const HELP_FLAGS = new Set(['--help', '-h', 'help']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version']);
/** Flags of `check` that take a value, with the example shown when the value is missing. */
const CHECK_VALUE_FLAGS: ReadonlyMap<string, string> = new Map([
  ['--account', '<address|publicKey|namespace>'],
  ['--warn-days', String(DEFAULT_WARN_DAYS)],
  ['--format', 'json'],
]);

/** Interprets `process.argv.slice(2)`. The first recognised word wins; anything else is unknown. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const first = argv[0];
  if (first === undefined) return { mode: 'serve' };
  if (HELP_FLAGS.has(first)) return { mode: 'help' };
  if (VERSION_FLAGS.has(first)) return { mode: 'version' };
  if (first === 'check') return parseCheckArgs(argv.slice(1));
  return { mode: 'unknown', arg: first };
}

/** Flags of `check`, as `--flag value` or `--flag=value`. Anything unexpected is a usage error. */
function parseCheckArgs(args: readonly string[]): CliCommand {
  const usage = (message: string): CliCommand => ({ mode: 'check_usage', message });
  const values = new Map<string, string>();
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';
    if (HELP_FLAGS.has(token)) return { mode: 'help' };
    const eq = token.indexOf('=');
    const flag = eq < 0 ? token : token.slice(0, eq);
    if (flag === '--quiet') {
      if (eq >= 0) return usage('--quiet takes no value.');
      quiet = true;
      continue;
    }
    if (!CHECK_VALUE_FLAGS.has(flag)) {
      return usage(
        `unknown argument ${JSON.stringify(maskIdentifier(token))}. Options are --account, --warn-days, --format and --quiet.`,
      );
    }
    if (values.has(flag)) return usage(`${flag} was given more than once.`);
    let value: string | undefined;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      value = args[i + 1];
      i++;
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      return usage(`${flag} needs a value, e.g. ${flag} ${CHECK_VALUE_FLAGS.get(flag)}.`);
    }
    values.set(flag, value);
  }

  let warnDays = DEFAULT_WARN_DAYS;
  const rawDays = values.get('--warn-days');
  if (rawDays !== undefined) {
    const n = /^\d{1,3}$/.test(rawDays) ? Number(rawDays) : Number.NaN;
    if (!(n >= MIN_WARN_DAYS && n <= MAX_WARN_DAYS)) {
      return usage(
        `--warn-days must be a whole number from ${MIN_WARN_DAYS} to ${MAX_WARN_DAYS} (default ${DEFAULT_WARN_DAYS}), got ${JSON.stringify(maskIdentifier(rawDays))}.`,
      );
    }
    warnDays = n;
  }

  const format = values.get('--format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    return usage(`--format must be text or json, got ${JSON.stringify(maskIdentifier(format))}.`);
  }

  const account = values.get('--account') ?? null;
  if (account !== null && classifyAccountId(account).kind === 'invalid') {
    return usage(
      `--account ${JSON.stringify(maskIdentifier(account.trim()))} is not a valid Symbol account identifier. ${ACCOUNT_INPUT_HINT}`,
    );
  }
  return { mode: 'check', options: { account, warnDays, format, quiet } };
}

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Receives the check report, newline included. Never called in server mode. */
  readonly stdout: (text: string) => void;
  /** Receives one message per call, without the trailing newline. */
  readonly stderr: (text: string) => void;
  /** Starts the MCP server over stdio: the no-argument mode. */
  readonly serve: () => Promise<void>;
  readonly version: string;
  readonly now: () => Date;
}

/** Why the check could not even start, as the one or two stderr lines of exit code 3. */
function startupFailureText(err: unknown, env: CliDeps['env']): string {
  if (err instanceof ConfigError) {
    return `${err.message}\nThe check reads the same environment variables as the server; run "${SERVER_NAME} --help" for the list.`;
  }
  if (err instanceof NetworkVerificationError) return err.message;
  if (err instanceof RestError) {
    let host = 'the node';
    try {
      host = new URL(env.SYMBOL_NODE_URL ?? '').host;
    } catch {
      // loadConfig has already accepted the URL; keep the generic wording if it somehow fails.
    }
    const status = err.status ? ` ${err.status}` : '';
    return `could not read ${err.path} from ${host} (${err.kind}${status}), so nothing was checked.\nVerify SYMBOL_NODE_URL (scheme, host, and port: 3000 for http, 3001 for https) and that the node is up and reachable from this machine.`;
  }
  return `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

async function runCheckCommand(options: CheckCliOptions, deps: CliDeps): Promise<number> {
  const say = (text: string) => deps.stderr(`${SERVER_NAME} check: ${text}`);
  let report: CheckReport;
  try {
    const ctx = await createAppContext(deps.env, SERVER_NAME, deps.version, deps.now);
    report = await runCheck(ctx, {
      account: options.account,
      warnDays: options.warnDays,
      onDiagnostic: say,
    });
  } catch (err) {
    say(startupFailureText(err, deps.env));
    return 3;
  }
  // --quiet keeps cron silent on success; anything else must reach the mail.
  if (!(options.quiet && report.exitCode === 0)) {
    deps.stdout(options.format === 'json' ? formatCheckJson(report) : formatCheckText(report));
  }
  return report.exitCode;
}

/**
 * Runs the binary for `argv` and returns the exit code; index.ts only wires the real process in.
 * Server mode returns once the stdio transport is listening (a start-up failure is thrown to the
 * caller, as before); every other mode returns when it is done.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const cli = parseCliArgs(argv);
  switch (cli.mode) {
    case 'serve':
      await deps.serve();
      return 0;
    case 'help':
      deps.stderr(helpText(SERVER_NAME, deps.version));
      return 0;
    case 'version':
      deps.stderr(`${SERVER_NAME} ${deps.version}`);
      return 0;
    case 'check':
      return runCheckCommand(cli.options, deps);
    case 'check_usage':
      deps.stderr(
        `${SERVER_NAME} check: ${cli.message}\nRun "${SERVER_NAME} --help" for the options and exit codes.`,
      );
      return 3;
    default:
      deps.stderr(
        `${SERVER_NAME}: unknown argument ${JSON.stringify(cli.arg)}. The server is configured through environment variables, not flags; run "${SERVER_NAME} --help" for the list.`,
      );
      return 2;
  }
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
  {
    name: 'SYMBOL_STATE_DIR',
    required: false,
    description:
      'Absolute directory where symbol_harvester_watch keeps one snapshot file per node (unlocked harvester public keys, heights and times; no secrets). Created on first save. Unset: the tool reports the current list without a comparison.',
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
  out.push(`  ${serverName} check        One-shot node health check for cron (see below)`);
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
  out.push('Check mode (no MCP client; same environment variables, SYMBOL_NODE_URL required):');
  out.push(`  ${serverName} check [--account <address|publicKey|namespace>]`);
  out.push('      [--warn-days <n>] [--format text|json] [--quiet]');
  out.push('  Runs node_health, version_drift, harvester_watch (needs SYMBOL_STATE_DIR) and, with');
  out.push('  --account, voting_key_status and finality_participation: the judgments of the MCP');
  out.push('  tools, read as ok / warn / fail / skip. The report goes to stdout. Nothing is sent');
  out.push("  anywhere: let cron's MAILTO mail the output.");
  out.push('    --account <id>    Voting account: address, public key or namespace name');
  out.push(
    `    --warn-days <n>   Warn when the active voting key expires within n days (${MIN_WARN_DAYS}-${MAX_WARN_DAYS}, default ${DEFAULT_WARN_DAYS})`,
  );
  out.push('    --format <f>      text (default) or json');
  out.push('    --quiet           Print nothing when the exit code is 0');
  out.push('  Exit codes: 0 all ok or skipped, 1 warnings, 2 failures,');
  out.push('              3 could not run (configuration, node unreachable, bad arguments)');
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
