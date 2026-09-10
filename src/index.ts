#!/usr/bin/env node
/**
 * Entry point: load configuration, verify the node's network, then serve MCP over stdio.
 *
 * stdout is the JSON-RPC channel. All logging goes to stderr via console.error.
 */
import { createRequire } from 'node:module';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { helpText, parseCliArgs } from './cli.js';
import { RestClient } from './client/rest.js';
import { loadConfig, resolveNetwork } from './config.js';
import { AppContext } from './context.js';
import { createServer, SERVER_NAME } from './server.js';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const version = readVersion();

  // Any argument comes from a human at a terminal; MCP hosts pass none. Never write to stdout.
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.mode === 'help') {
    console.error(helpText(SERVER_NAME, version));
    return;
  }
  if (cli.mode === 'version') {
    console.error(`${SERVER_NAME} ${version}`);
    return;
  }
  if (cli.mode === 'unknown') {
    console.error(
      `${SERVER_NAME}: unknown argument ${JSON.stringify(cli.arg)}. The server is configured through environment variables, not flags; run "${SERVER_NAME} --help" for the list.`,
    );
    process.exit(2);
  }

  const config = loadConfig(process.env);
  const rest = new RestClient({
    baseUrl: config.nodeUrl,
    timeoutMs: config.requestTimeoutMs,
    userAgent: `${SERVER_NAME}/${version}`,
  });
  const network = await resolveNetwork(rest, config);
  const ctx = new AppContext(config, rest, network, version);

  const tz = config.timeZone ? `, timezone ${config.timeZone}` : '';
  const refs =
    config.referenceNodes.length > 0 ? `, ${config.referenceNodes.length} reference node(s)` : '';
  console.error(`${SERVER_NAME} ${version}: ${network.name} via ${rest.host}${tz}${refs}`);

  serveStdio(() => createServer(ctx), {
    onerror: (err) => console.error(`${SERVER_NAME}: ${err.message}`),
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${SERVER_NAME} failed to start: ${message}`);
  process.exit(1);
});
