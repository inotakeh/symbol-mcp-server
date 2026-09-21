#!/usr/bin/env node
/**
 * Entry point: wires the real process into runCli. With no arguments it loads the configuration,
 * verifies the node's network and serves MCP over stdio; `check` prints one health report.
 *
 * In server mode stdout is the JSON-RPC channel and all logging goes to stderr via console.error.
 * The stdout writer below is only ever reached by the `check` subcommand, which never serves MCP.
 */
import { createRequire } from 'node:module';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { runCli } from './cli.js';
import { createAppContext } from './context.js';
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

async function serve(version: string): Promise<void> {
  const ctx = await createAppContext(process.env, SERVER_NAME, version);
  const { config, rest, network } = ctx;

  const tz = config.timeZone ? `, timezone ${config.timeZone}` : '';
  const refs =
    config.referenceNodes.length > 0 ? `, ${config.referenceNodes.length} reference node(s)` : '';
  const state = config.stateDir ? `, state dir ${config.stateDir}` : '';
  console.error(`${SERVER_NAME} ${version}: ${network.name} via ${rest.host}${tz}${refs}${state}`);

  serveStdio(() => createServer(ctx), {
    onerror: (err) => console.error(`${SERVER_NAME}: ${err.message}`),
  });
}

async function main(): Promise<void> {
  const version = readVersion();
  // Any argument comes from a human at a terminal or from cron; MCP hosts pass none.
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => console.error(text),
    serve: () => serve(version),
    version,
    now: () => new Date(),
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${SERVER_NAME} failed to start: ${message}`);
  process.exit(1);
});
