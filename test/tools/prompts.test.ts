/**
 * MCP prompts: listed in registration order, rendered with the account argument, and free of
 * real-world identifiers. The "no real values" check runs on the templates (before {account} is
 * substituted) and on the rendered text with the passed account removed, so the substituted
 * address itself never trips it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROMPTS } from '../../src/server.js';
import { startTestServer, type TestServer } from './harness.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADDRESS = 'NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY';

const REAL_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[NT][A-Z2-7]{38}\b/, 'base32 address'],
  [/[0-9A-Fa-f]{48,}/, 'hex address, key or hash'],
  [/https?:\/\//, 'URL'],
  [/\b[a-z0-9-]+\.(?:jp|com|net|org|io|dev|tools)\b/, 'host name'],
  [/\b20\d\d-\d\d(?:-\d\d)?\b/, 'calendar date'],
];

function realValuesIn(text: string): string[] {
  return REAL_VALUE_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

async function getText(name: string, account: string): Promise<string> {
  if (!server) throw new Error('server not started');
  const result = await server.client.getPrompt({ name, arguments: { account } });
  expect(result.messages).toHaveLength(1);
  const message = result.messages[0];
  if (!message) throw new Error('prompt returned no message');
  expect(message.role).toBe('user');
  expect(message.content.type).toBe('text');
  return (message.content as { text: string }).text;
}

describe('prompts', () => {
  it('lists both prompts in registration order with a required account argument', async () => {
    server = await startTestServer();
    const { prompts } = await server.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(PROMPTS.map((p) => p.name));
    expect(prompts.map((p) => p.name)).toEqual([
      'voting_key_renewal_checklist',
      'monthly_health_check',
    ]);
    for (const prompt of prompts) {
      expect(prompt.title).toBeTruthy();
      expect(prompt.description).toBeTruthy();
      expect(prompt.arguments?.map((a) => [a.name, a.required])).toEqual([['account', true]]);
      expect(prompt.arguments?.[0]?.description).toMatch(/base32 address/i);
    }
    const again = (await server.client.listPrompts()).prompts.map((p) => p.name);
    expect(again).toEqual(prompts.map((p) => p.name));
  });

  it('renders the renewal checklist with the account and the tools in order', async () => {
    server = await startTestServer();
    const text = await getText('voting_key_renewal_checklist', ADDRESS.toLowerCase());
    expect(text).toContain(`account "${ADDRESS}"`);
    expect(text).not.toContain('{account}');
    const order = [
      'symbol_voting_key_status',
      'symbol_node_status',
      'symbol_network_compare',
      'symbol_transaction_status',
      'symbol_finality_participation',
      'Current key / New key / Expiry / Open items',
    ];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toMatch(/never signs or announces/);
    expect(text).toMatch(/slotsFree is 0/);
    expect(text).toMatch(/not synced, stop/);
    expect(text).toMatch(/startEpoch has been finalized/);
    expect(text).toMatch(/"participated"/);
  });

  it('renders the monthly health check with last month and the three-level report', async () => {
    server = await startTestServer();
    const text = await getText('monthly_health_check', ADDRESS);
    expect(text).toContain(`account "${ADDRESS}"`);
    const order = [
      'symbol_node_status',
      'symbol_node_health',
      'symbol_version_drift',
      'symbol_network_compare',
      'symbol_harvester_watch',
      'symbol_harvesting_status',
      'symbol_voting_key_status',
      'symbol_account_get',
      'symbol_harvesting_income',
    ];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toMatch(/behind or far_behind/);
    expect(text).toMatch(/mode "compare_and_save"/);
    expect(text).toMatch(/negative deltaCount/);
    expect(text).toMatch(/previous calendar month/);
    expect(text).toMatch(/granularity "daily"/);
    expect(text).toMatch(/within 30 days/);
    expect(text).toMatch(/Action required \/ Attention \/ Normal/);
  });

  it('requires the account argument and rejects values that are not base32 addresses', async () => {
    server = await startTestServer();
    await expect(
      server.client.getPrompt({ name: 'voting_key_renewal_checklist' }),
    ).rejects.toThrow();
    await expect(
      server.client.getPrompt({ name: 'monthly_health_check', arguments: { account: '' } }),
    ).rejects.toThrow();
    await expect(
      server.client.getPrompt({
        name: 'monthly_health_check',
        arguments: { account: 'CE1992333C60AFEABDB289A14CC1A593FB797339C6D93DEEDB97052AED51845E' },
      }),
    ).rejects.toThrow(/39-character base32 address/);
    await expect(server.client.getPrompt({ name: 'no_such_prompt' })).rejects.toThrow();
  });

  it('contains no real address, host, key, hash or date', async () => {
    for (const prompt of PROMPTS) {
      expect(realValuesIn(prompt.template), prompt.name).toEqual([]);
      expect(realValuesIn(prompt.description), prompt.name).toEqual([]);
    }
    server = await startTestServer();
    for (const prompt of PROMPTS) {
      const rendered = await getText(prompt.name, ADDRESS);
      expect(realValuesIn(rendered.split(ADDRESS).join('')), prompt.name).toEqual([]);
    }
  });
});
