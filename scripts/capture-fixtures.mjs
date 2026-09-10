#!/usr/bin/env node
/**
 * Captures REST responses from a Symbol node into test/fixtures/<network>/ so the tool-layer
 * tests run against real payloads. Development-only; the MCP server never loads this file.
 *
 *   node scripts/capture-fixtures.mjs https://<node-host>:3001 [--account <address|publicKey>] [--force]
 *
 * Constraints (see docs/DESIGN-BRIEF.md):
 *   - the node URL must be https:// (the only network access this script performs)
 *   - files are written only under test/fixtures/<network>/ (network detected from /node/info)
 *   - existing files are kept unless --force is given
 *   - responses are stored verbatim (pretty-printed JSON). The account-specific mainnet fixtures
 *     were later post-processed to replace on-chain identifiers; see test/fixtures/README.md
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'test', 'fixtures');
const TIMEOUT_MS = 20_000;
const USER_AGENT = 'symbol-mcp-server/capture-fixtures';

/** The only network constants the project hard-codes (generation hash seed -> name). */
const KNOWN_NETWORKS = {
  '57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6': 'mainnet',
  '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4': 'testnet',
};

/** Known ids: symbol.xym namespace and its root. */
const NAMESPACE_XYM = 'E74B99BA41F4AFEE';
const NAMESPACE_ROOT = 'A95F1F8A96159516';
const TYPE_TRANSFER = 16724; // 0x4154
const TYPE_AGGREGATE_COMPLETE = 16705; // 0x4141
const TYPE_AGGREGATE_BONDED = 16961; // 0x4241

const log = (...args) => console.error('[capture]', ...args);

function usage(message) {
  log(message);
  log(
    'usage: node scripts/capture-fixtures.mjs https://<node-host>:3001 [--account <address|publicKey>] [--force]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const force = argv.includes('--force');
  let account;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') continue;
    if (argv[i] === '--account') {
      account = argv[++i];
      if (!account || !/^([A-Z2-7]{39}|[0-9A-F]{64})$/i.test(account)) {
        usage('--account expects a 39-character base32 address or a 64-character hex public key');
      }
      continue;
    }
    args.push(argv[i]);
  }
  if (args.length !== 1) usage('exactly one node URL is required');
  let url;
  try {
    url = new URL(args[0]);
  } catch {
    usage(`not a URL: ${args[0]}`);
  }
  if (url.protocol !== 'https:') usage('the node URL must start with https://');
  if (url.username || url.password || url.search || url.hash) {
    usage('the node URL must not contain credentials, a query string or a fragment');
  }
  return { baseUrl: url.toString().replace(/\/+$/, ''), force, account };
}

async function request(baseUrl, method, path, body) {
  const init = {
    method,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: non-JSON response (HTTP ${response.status})`);
  }
  return { status: response.status, json };
}

function writeFixture(outDir, name, data, force) {
  const target = resolve(outDir, name);
  if (!target.startsWith(`${outDir}${sep}`)) throw new Error(`refusing to write outside ${outDir}`);
  if (existsSync(target) && !force) {
    log(`skip (exists) ${name}`);
    return;
  }
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  log(`wrote ${name}`);
}

async function main() {
  const { baseUrl, force, account } = parseArgs(process.argv.slice(2));
  const get = (path) => request(baseUrl, 'GET', path);
  const post = (path, body) => request(baseUrl, 'POST', path, body);

  const nodeInfo = await get('/node/info');
  if (nodeInfo.status !== 200) throw new Error(`/node/info answered HTTP ${nodeInfo.status}`);
  const seed = String(nodeInfo.json.networkGenerationHashSeed ?? '').toUpperCase();
  const network = KNOWN_NETWORKS[seed];
  if (!network) throw new Error(`unknown network (generation hash seed ${seed})`);
  const outDir = resolve(FIXTURE_ROOT, network);
  if (!outDir.startsWith(`${FIXTURE_ROOT}${sep}`)) throw new Error('bad fixture directory');
  mkdirSync(outDir, { recursive: true });
  log(`node ${baseUrl} is ${network}; writing to ${outDir}`);

  // 1. Newest confirmed transfer and aggregate transactions, then their hash lookups.
  const latestOfType = async (type) => {
    const page = await get(`/transactions/confirmed?type=${type}&pageSize=1&order=desc`);
    const hash = page.json?.data?.[0]?.meta?.hash;
    return hash ? String(hash) : undefined;
  };
  const transferHash = await latestOfType(TYPE_TRANSFER);
  if (!transferHash) throw new Error('no confirmed transfer transaction found');
  const transfer = await get(`/transactions/confirmed/${transferHash}`);
  writeFixture(outDir, 'transaction-transfer.json', transfer.json, force);

  const aggregateHash =
    (await latestOfType(TYPE_AGGREGATE_COMPLETE)) ?? (await latestOfType(TYPE_AGGREGATE_BONDED));
  if (aggregateHash) {
    const aggregate = await get(`/transactions/confirmed/${aggregateHash}`);
    writeFixture(outDir, 'transaction-aggregate.json', aggregate.json, force);
  } else {
    log('no aggregate transaction found; transaction-aggregate.json not written');
  }

  // 2. A search page for --account, or for the node's own main account when not given.
  const searchQuery = account
    ? `address=${account.toUpperCase()}`
    : `signerPublicKey=${nodeInfo.json.publicKey}`;
  const search = await get(`/transactions/confirmed?${searchQuery}&pageSize=2&order=desc`);
  writeFixture(outDir, 'transactions-search.json', search.json, force);

  // 3. The real 404 body for a confirmed hash looked up in the unconfirmed group.
  const unconfirmed = await get(`/transactions/unconfirmed/${transferHash}`);
  writeFixture(
    outDir,
    'transaction-unconfirmed-404.json',
    { status: unconfirmed.status, body: unconfirmed.json },
    force,
  );

  // 4. Namespaces: symbol.xym, its root, and the names lookup for both.
  const xym = await get(`/namespaces/${NAMESPACE_XYM}`);
  writeFixture(outDir, 'namespace-symbol-xym.json', xym.json, force);
  const root = await get(`/namespaces/${NAMESPACE_ROOT}`);
  writeFixture(outDir, 'namespace-symbol.json', root.json, force);
  const names = await post('/namespaces/names', { namespaceIds: [NAMESPACE_XYM, NAMESPACE_ROOT] });
  writeFixture(outDir, 'namespace-names.json', names.json, force);

  // 5. Harvesting: delegated accounts unlocked on this node.
  const unlocked = await get('/node/unlockedaccount');
  writeFixture(outDir, 'unlockedaccount.json', unlocked.json, force);
  if (unlocked.status !== 200) log(`note: /node/unlockedaccount answered HTTP ${unlocked.status}`);

  log('done');
}

main().catch((err) => {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
